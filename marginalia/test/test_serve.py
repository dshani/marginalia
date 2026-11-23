"""Tests for tools/serve.py's Obsidian API (BUILD-NOTES "Obsidian") and its backups ("Automatic backup").

Run from the app folder:  python3 -I -m unittest discover -s test -p 'test_*.py'

Every test runs the real request handler on an ephemeral 127.0.0.1 port in a thread, with a throwaway vault and its
own obsidian.json in a fresh temp folder (tempfile: set TMPDIR to choose where), handed to the server through the
MARGINALIA_OBSIDIAN_CONFIG environment variable exactly as bin/marginalia would. Nothing outside that temp folder is
read or written; the setup refuses to run if the configured vault is anywhere else. Every server a test makes or
starts gets a throwaway backup folder in the temp folder too (make_server(backup_dir=...), --backup-dir or
MARGINALIA_BACKUP_DIR), never ~/Documents/Marginalia Backups. Requests "from another machine" are handed to the same
handler over a socket pair with a made-up client address (no network is opened).

ObsidianApiTest: listing, create, append, replace, hand-edited markers, blocks merged by hand (the date line must be
the block's own), fenced copies and fences Obsidian does not leave open, Unicode, attributes kept and read-only or
hard-linked notes refused, two vaults with one name, unexpected errors, non-loopback clients; "Send all" (POST
/api/obsidian/notes): create, update in place, the same text as one single send after another, invalid blocks
reported and skipped, a blockId given twice, one read and one atomic write, line ends, byte order mark, mode and
attributes kept, read-only and hard-linked notes, images, limits, the same guards on every route; on both routes, a
save another app makes while a send runs (in place, by a new file, or a new note) is kept and the send goes in on top
of it, and a note that keeps changing is left as it is (409 after NOTE_TRIES reads). "replaceOnly" (A8: an edited card
sent before): its copy replaced in place; a copy deleted, hand-edited, merged, fenced or sent through a link never
added again (notFound, the note not even rewritten); a request whose every block is such a one writes nothing and
makes no note, folder or image; mixed requests, which write no image of a card left out either (only one a card that
goes in embeds too; picked again when a save makes the server read the note again); replaceOnly must be true or
false; a copy deleted while the send runs; the single /note never reads it; GET /vaults says "replaceOnly": true; and,
on random hand-edited notes through the endpoint, the note ends as single sends of the cards that went would leave it,
never with a second copy.
PureHelpersTest: find_block, date_kind, check_block, fenced, the marker pattern's linear time, and upsert_blocks /
find_span against upsert_text / find_block on generated notes (hand edits, stray fences, line ends; batches that end
where fences change far from a block, a note's first "\r\n", one id twice; replace_only blocks, which never add a block
of their id, also before the first block that goes in), and their speed (long blocks, replace_only ones too).
BackupApiTest: GET and POST /api/backup with a temp folder: auto once a day, manual replaces, the file is the backup's
own text, the prune keeps the 30 newest and never touches another file, refusals (a file with today's name in other
letters too), failed writes leave no temp file, servers without a backup folder. PdfBackupApiTest (FEATURES B9): the
PDFs saved once in <backup folder>/PDFs (GET /api/backup/pdfs, POST /api/backup/pdf, GET /api/backup/pdf/<sha256>):
saved as a normal PDF file, once (by its sha12, whatever the name), the name cleaned as js/obsidian.js cleans a note
name, a wrong SHA-256, a body that is not a PDF, the 300 MB limit and the guards refused before anything is written,
the bytes sent only when they hash to the asked SHA-256 (never through a symlink; a file that changes while it is sent
never arrives whole), two uploads at once, failed writes and a stop leave no temp file, a name held by a folder or a
link, a PDFs folder that is a link, a saved PDF changed after it was saved (repair B9-R2: never sent, named in the 404,
renamed aside with the user's changes when the PDF is uploaded again); and the prune after each backup written: a PDF
stays while a kept backup lists it for a live book (the oldest kept, hex in capitals, a PDF that an old tombstone
shares with a live book in either order, a book deleted since) or for a book deleted less than 30 days ago (D23:
also when Back up now replaced the only backup that listed it alive; deletedAt read as js/exporter.js stampOf reads
it, its age from serve.now_ms()), only unlisted files of the exact
pattern that still hold what their names say go (never a decoy, a folder, a symlink, a file that cannot be read, or one
changed after it was saved, which is renamed aside), and nothing goes while a kept backup cannot be read or parsed. ServerOptionsTest: --obsidian-config,
--obsidian-sandbox (never Obsidian's own folder, never a vault list it did not write), blank values and configs that
list no vault (the server does not start), the backup folder (option, variable, a sandbox's own Backups folder, a
Backups folder beside a vault list of the server's own (B8: --obsidian-config or MARGINALIA_OBSIDIAN_CONFIG; Obsidian's
own list named explicitly keeps the user's folder; never inside Obsidian's settings folder), default; blank, relative
or inside the app folder stops the server; nothing is made at start), and SIGTERM during a send, a backup or a PDF
upload; --app (FEATURES E2.1): only digits.digits.digits, else exit 2 with nothing made, and the app's server started
as the desktop app starts it (a fourth start line, GET /api/app, a POST refused without the app's header and taken
with it). The tests that run tools/serve.py itself (port 0, killed if it ever serves) give it HOME = a fake home in the
temp area whose Obsidian list names only a decoy, and a temp backup folder (or a sandbox or a vault list of its own,
whose backups stay beside it).
AppServerTest (FEATURES E2.1 a-c): the desktop app's server (make_server(app_version=...)) beside one made without
it: GET /api/app (only with the flag; else exactly an unknown route's 404; the GET guards), every POST route refused
with the 409 "app_only" unless X-Marginalia-Client says "app" (the backup routes also take "browser-move"), after the
other guards (Origin, X-Marginalia, Host, Content-Type, the size limit) and before the body is read, with nothing
written; without the flag the header changes nothing; GET routes need no header; the version check.
LatestBackupApiTest (FEATURES E2.1 d): GET /api/backup/latest on a plain server, an app's server and one without a
backup folder: the newest kept backup byte for byte with X-Marginalia-Backup-Name (GET /api/backup's first file),
never what that listing leaves out (symlinks, folders, FIFOs, other names), never through a symlink or a FIFO put in
its place, streamed in pieces and cut off when the file gets shorter meanwhile; 404 "no_backup"; Sec-Fetch-Site,
other machines and the Host check refused, another site before the folder is read.
"""
import base64
import contextlib
import errno
import hashlib
import http.client
import importlib.util
import io
import json
import os
import random
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
SERVE_PY = os.path.join(APP, "tools", "serve.py")

_spec = importlib.util.spec_from_file_location("marginalia_serve", SERVE_PY)
serve = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(serve)

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def block(pid, body):
    return "<!-- marginalia:%s -->\n### p. 1\n> a quote\n\n%s\n\n2026-11-06\n<!-- /marginalia -->" % (pid, body)


def linked(pid, body):
    """A block as the app writes it on localhost: the date line carries the "Open in Marginalia" link."""
    return block(pid, body).replace("\n2026-11-06\n", "\n[Open in Marginalia](http://127.0.0.1:8765/#reader/b1/%s) · 2026-11-06\n" % pid)


def one_by_one(note, items):
    """What one single /note send after another leaves in `note` (upsert_text, which replaces the span find_block
    claims, else adds the block) for items (markdown, blockId) or (markdown, blockId, replace_only); a replace_only
    block is sent only when find_block claims its earlier copy in the note as the sends before it left it, and is
    otherwise left out (flag None). -> (text, [True replaced | False added | None left out])."""
    text, flags = note, []
    for item in items:
        md, pid, only = item if len(item) > 2 else (item[0], item[1], False)
        lines = md.replace("\r\n", "\n").split("\n")
        own = serve.date_kind(lines[-2] if len(lines) > 1 else "", pid) == "own"
        if only and serve.find_block(text, pid, own) is None:
            flags.append(None)
            continue
        text, replaced = serve.upsert_text(text, md, pid)
        flags.append(replaced)
    return text, flags


def starts_of(text, pid):
    """How many blocks of `pid` a note holds: its start-marker text, anywhere (fenced, edited or not)."""
    return text.count("<!-- marginalia:%s -->" % pid)


def http_request(port, method, path, body=None, headers=None):
    """One request to 127.0.0.1:port (body: bytes, or anything json.dumps takes). -> (status, headers, JSON, raw)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    h = {"Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    conn.request(method, path, body=data, headers=h)
    r = conn.getresponse()
    raw = r.read()
    conn.close()
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except ValueError:
        payload = None
    return r.status, dict((k.lower(), v) for k, v in r.getheaders()), payload, raw


def post_headers(port):
    return {"Origin": "http://127.0.0.1:%d" % port, "X-Marginalia": "1", "Content-Type": "application/json"}


def via_socket(httpd, client, method, path, body=None, headers=None):
    """Hand one request to the server's real handler over a socket pair, as the server does for a connection from
    `client` (an (address, port) pair): the way to test an address other than loopback without a network."""
    port = httpd.server_address[1]
    h = {"Host": "127.0.0.1:%d" % port, "Connection": "close"}
    h.update(headers or {})
    data = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    if body is not None:
        h["Content-Length"] = str(len(data))
    head = "%s %s HTTP/1.1\r\n%s\r\n" % (method, path, "".join("%s: %s\r\n" % kv for kv in h.items()))
    mine, theirs = socket.socketpair()
    chunks = []
    try:
        mine.sendall(head.encode("latin-1") + data)
        httpd.RequestHandlerClass(theirs, client, httpd)     # answers the request before it returns
        theirs.close()
        while True:
            c = mine.recv(65536)
            if not c:
                break
            chunks.append(c)
    finally:
        mine.close()
        theirs.close()
    top, _, payload = b"".join(chunks).partition(b"\r\n\r\n")
    return int(top.split(b" ", 2)[1]), (json.loads(payload.decode("utf-8")) if payload else None)


def oversized(port, path, length):
    """A POST that announces `length` bytes and sends none: -> the status (the server must answer without reading)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.putrequest("POST", path, skip_host=True)
    for k, v in dict(post_headers(port), Host="127.0.0.1:%d" % port, **{"Content-Length": str(length)}).items():
        conn.putheader(k, v)
    conn.endheaders()
    r = conn.getresponse()
    status = r.status
    conn.close()
    return status


class ObsidianApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-serve-test-"))
        cls.config = os.path.join(cls.base, "obsidian.json")
        cls.backups = os.path.join(cls.base, "Backups")      # a throwaway backup folder, never the real one
        cls.old_env = os.environ.get(serve.CONFIG_ENV)
        os.environ[serve.CONFIG_ENV] = cls.config          # read per request, as `marginalia` passes it
        cls.httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, backup_dir=cls.backups)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(5)
        if cls.old_env is None:
            os.environ.pop(serve.CONFIG_ENV, None)
        else:
            os.environ[serve.CONFIG_ENV] = cls.old_env
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="case-", dir=self.base))
        self.vault = os.path.join(self.tmp, "Test Vault")
        self.outside = os.path.join(self.tmp, "outside")
        os.makedirs(os.path.join(self.vault, ".obsidian"))
        os.makedirs(self.outside)
        with open(os.path.join(self.vault, ".obsidian", "app.json"), "w", encoding="utf-8") as f:
            json.dump({"attachmentFolderPath": "Attachments", "newFileFolderPath": "Notes"}, f)
        self.write_config({
            "a1b2c3": {"path": self.vault, "ts": 1700000000000, "open": True},
            "gone00": {"path": os.path.join(self.tmp, "Missing Vault"), "ts": 1600000000000}
        })
        with open(self.config, encoding="utf-8") as f:
            for v in json.load(f)["vaults"].values():
                assert os.path.realpath(v["path"]).startswith(self.tmp + os.sep), "test vaults must live in the temp folder"
        self.assertEqual(os.environ.get(serve.CONFIG_ENV), self.config)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers

    def write_config(self, vaults):
        with open(self.config, "w", encoding="utf-8") as f:
            json.dump({"vaults": vaults}, f)

    def request(self, method, path, body=None, headers=None):
        return http_request(self.port, method, path, body, headers)

    def post(self, payload, headers=None):
        h = post_headers(self.port)
        h.update(headers or {})
        return self.request("POST", "/api/obsidian/note", payload, h)

    def note(self, pid="p_1", body="First text", **extra):
        payload = {"vault": "Test Vault", "file": "Notes/Marginalia/Book One.md", "title": "Book One",
                   "blockId": pid, "markdown": block(pid, body)}
        payload.update(extra)
        return payload

    def post_notes(self, payload, headers=None):
        h = post_headers(self.port)
        h.update(headers or {})
        return self.request("POST", "/api/obsidian/notes", payload, h)

    def notes(self, blocks, **extra):
        """A send-all request: blocks = [(blockId, markdown)] (or the list of block objects itself)."""
        payload = {"vault": "Test Vault", "file": "Notes/Marginalia/Book One.md", "title": "Book One",
                   "blocks": [{"blockId": pid, "markdown": md} for pid, md in blocks]
                   if all(isinstance(b, tuple) for b in blocks) else blocks}
        payload.update(extra)
        return payload

    def read(self, rel):
        with open(os.path.join(self.vault, *rel.split("/")), encoding="utf-8") as f:
            return f.read()

    def files_outside(self):
        out = []
        for d, _, files in os.walk(self.outside):
            out += [os.path.join(d, f) for f in files]
        return out

    # ---- listing

    def test_lists_existing_vaults_without_paths(self):
        status, headers, payload, raw = self.request("GET", "/api/obsidian/vaults")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(payload, {"vaults": [{"id": "a1b2c3", "name": "Test Vault", "open": True, "attachmentFolder": "Attachments"}],
                                   "replaceOnly": True})
        self.assertNotIn(self.tmp.encode("utf-8"), raw, "no absolute path in the response")
        self.assertNotIn(b"Missing Vault", raw, "a vault whose folder is missing is skipped")

    def test_two_vaults_with_one_name_list_the_open_one(self):
        for d in ("one", "two"):
            os.makedirs(os.path.join(self.tmp, d, "Same"))
        self.write_config({
            "old111": {"path": os.path.join(self.tmp, "one", "Same"), "ts": 1800000000000},
            "new222": {"path": os.path.join(self.tmp, "two", "Same"), "ts": 1700000000000, "open": True}
        })
        status, _, payload, _ = self.request("GET", "/api/obsidian/vaults")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"vaults": [{"id": "new222", "name": "Same", "open": True, "attachmentFolder": "/"}],
                                   "replaceOnly": True})

    def test_two_vaults_with_one_name_are_never_written_into(self):
        # the page names a vault by its folder name only: an update must not follow Obsidian's open flag into the other
        one, two = os.path.join(self.tmp, "one", "Same"), os.path.join(self.tmp, "two", "Same")
        for d in (one, two):
            os.makedirs(d)
        for open_one in (True, False):
            with self.subTest(open_one=open_one):
                self.write_config({"old111": {"path": one, "ts": 1800000000000, "open": open_one},
                                   "new222": {"path": two, "ts": 1700000000000, "open": not open_one}})
                status, _, payload, _ = self.post(self.note(vault="Same"))
                self.assertEqual(status, 409, payload)
                self.assertIn("two Obsidian vaults are named “Same”", payload["error"])
                self.assertEqual((os.listdir(one), os.listdir(two)), ([], []), "nothing was written")
        line = serve.startup_config(serve.parse_args(["--obsidian-config", self.config]))[1]
        self.assertIn("share the name Same", line)
        # one folder listed twice is one vault
        self.write_config({"old111": {"path": one, "ts": 1}, "dup333": {"path": one + "/", "ts": 2, "open": True}})
        status, _, payload, _ = self.post(self.note(vault="Same"))
        self.assertEqual((status, payload["created"]), (200, True), payload)
        self.assertTrue(os.path.isfile(os.path.join(one, "Notes", "Marginalia", "Book One.md")))

    def test_missing_config_lists_nothing(self):
        os.remove(self.config)
        status, _, payload, _ = self.request("GET", "/api/obsidian/vaults")
        self.assertEqual((status, payload), (200, {"vaults": [], "replaceOnly": True}))

    def test_static_files_keep_no_cache(self):
        status, headers, _, raw = self.request("GET", "/index.html")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-cache")
        self.assertIn(b"Marginalia", raw)

    # ---- writes

    def test_create_makes_folders_and_starts_with_the_title(self):
        status, headers, payload, _ = self.post(self.note())
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(payload, {"ok": True, "file": "Notes/Marginalia/Book One.md", "created": True, "replaced": False})
        self.assertEqual(self.read("Notes/Marginalia/Book One.md"), "# Book One\n\n" + block("p_1", "First text") + "\n")

    def test_deep_folders_are_created(self):
        status, _, payload, _ = self.post(self.note(file="A/B/C/Deep Book.md", title="Deep Book"))
        self.assertEqual(status, 200, payload)
        self.assertTrue(os.path.isfile(os.path.join(self.vault, "A", "B", "C", "Deep Book.md")))

    def test_append_adds_a_block_after_one_blank_line(self):
        self.post(self.note("p_1", "First text"))
        status, _, payload, _ = self.post(self.note("p_2", "Second text"))
        self.assertEqual(status, 200, payload)
        self.assertEqual((payload["created"], payload["replaced"]), (False, False))
        self.assertEqual(self.read("Notes/Marginalia/Book One.md"),
                         "# Book One\n\n" + block("p_1", "First text") + "\n\n" + block("p_2", "Second text") + "\n")

    def test_append_to_a_file_without_a_trailing_newline(self):
        path = os.path.join(self.vault, "Mine.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("my own words")
        status, _, payload, _ = self.post(self.note(file="Mine.md"))
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.read("Mine.md"), "my own words\n\n" + block("p_1", "First text") + "\n")

    def test_replace_same_block_keeps_everything_else(self):
        self.post(self.note("p_1", "First text"))
        self.post(self.note("p_2", "Second text"))
        path = os.path.join(self.vault, "Notes", "Marginalia", "Book One.md")
        with open(path, "a", encoding="utf-8") as f:
            f.write("\nMy own paragraph.\n")
        status, _, payload, _ = self.post(self.note("p_1", "Edited text\nwith two lines"))
        self.assertEqual(status, 200, payload)
        self.assertEqual((payload["created"], payload["replaced"]), (False, True))
        text = self.read("Notes/Marginalia/Book One.md")
        self.assertEqual(text, "# Book One\n\n" + block("p_1", "Edited text\nwith two lines") + "\n\n" +
                         block("p_2", "Second text") + "\n\nMy own paragraph.\n")
        self.assertEqual(text.count("<!-- marginalia:p_1 -->"), 1)

    def test_a_block_whose_end_marker_was_deleted_is_appended_not_clobbered(self):
        self.post(self.note("p_1", "First text"))
        self.post(self.note("p_2", "Second text"))
        rel = "Notes/Marginalia/Book One.md"
        broken = self.read(rel).replace(block("p_1", "First text"), block("p_1", "First text").replace("\n<!-- /marginalia -->", ""), 1)
        with open(os.path.join(self.vault, *rel.split("/")), "w", encoding="utf-8") as f:
            f.write(broken)
        status, _, payload, _ = self.post(self.note("p_1", "Sent again"))
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["replaced"], False)
        text = self.read(rel)
        self.assertTrue(text.startswith(broken), "nothing before the new block changed")
        self.assertIn(block("p_2", "Second text"), text, "the next block survives")
        self.assertTrue(text.endswith("\n\n" + block("p_1", "Sent again") + "\n"))

    def write_note_file(self, rel, text):
        path = os.path.join(self.vault, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def assert_appended_untouched(self, rel, before, pid, body, make=block):
        """The re-send (`make` builds its block: block = the date alone, linked = as the app sends it) left every byte
        of the note as it was and appended one new block after one blank line."""
        status, _, payload, _ = self.post(self.note(pid, body, file=rel, markdown=make(pid, body)))
        self.assertEqual(status, 200, payload)
        self.assertEqual((payload["created"], payload["replaced"]), (False, False))
        self.assertEqual(self.read(rel), before + "\n" + make(pid, body) + "\n")

    def test_deleted_markers_between_two_blocks_never_swallow_the_next_block(self):
        # Obsidian tidy-up: the two comment lines between A and B deleted by hand, then the user's own paragraph
        rel = "Notes/Marginalia/Swallow.md"
        a, b = linked("p_A", "alpha"), linked("p_B", "beta")
        joined = a.replace("\n<!-- /marginalia -->", "") + "\n\n" + b.replace("<!-- marginalia:p_B -->\n", "")
        before = "# Swallow\n\n" + joined.replace("\nbeta\n", "\nbeta\n\nMy thoughts on B, typed in Obsidian.\n") + "\n"
        self.write_note_file(rel, before)
        self.assertIn("My thoughts on B", before)
        self.assert_appended_untouched(rel, before, "p_A", "ALPHA sent again", make=linked)

    def test_blocks_merged_by_hand_are_never_taken_by_an_update(self):
        # The span from A's start marker to the next exact end marker holds one date line, but it is not A's: an
        # update of A must append, never take B (or C) and the text the user wrote with them.
        rel = "Notes/Marginalia/Merged.md"
        a, b, c = linked("p_A", "alpha"), linked("p_B", "beta"), linked("p_C", "gamma")

        def seam(x, next_id):          # x's date line through the next block's start marker: one selection in Obsidian
            return x.split("\n")[-2] + "\n<!-- /marginalia -->\n\n<!-- marginalia:%s -->\n" % next_id
        two = "# Merged\n\n" + a + "\n\n" + b + "\n\nMy closing thoughts.\n"
        between = "# Merged\n\n" + a + "\n\nMy paragraph between the blocks.\n\n" + b + "\n"
        da, db = block("p_A", "alpha"), block("p_B", "beta")          # sent through obsidian:// links: the date alone
        cases = {
            "selection typed over": two.replace(seam(a, "p_B"), "My bridge sentence.\n"),
            "selection deleted": two.replace(seam(a, "p_B"), ""),
            "A's date line edited, the comment lines deleted, a paragraph in B":
                two.replace(seam(a, "p_B"), a.split("\n")[-2] + " #seen\n\n").replace(
                    "\nbeta\n", "\nbeta\n\nMy thoughts on B, typed in Obsidian.\n"),
            "a paragraph between the blocks, then A's date line, A's end and B's start deleted":
                between.replace(a.split("\n")[-2] + "\n<!-- /marginalia -->\n", "").replace("<!-- marginalia:p_B -->\n", ""),
            "three blocks merged": ("# Merged\n\n" + a + "\n\n" + b + "\n\n" + c + "\n").replace(
                seam(a, "p_B"), "Bridge one.\n").replace(seam(b, "p_C"), "Bridge two.\n"),
            "two link-mode blocks merged": ("# Merged\n\n" + da + "\n\n" + db + "\n").replace(seam(da, "p_B"), ""),
        }
        for label, before in cases.items():
            with self.subTest(label):
                self.assertNotIn("<!-- marginalia:p_B -->", before)          # the hand edit really happened
                self.assertEqual(before.count("<!-- /marginalia -->"), 1)
                self.write_note_file(rel, before)
                self.assert_appended_untouched(rel, before, "p_A", "ALPHA sent again", make=linked)
        # the same merge in a CRLF note
        before = two.replace(seam(a, "p_B"), "My bridge sentence.\n").replace("\n", "\r\n")
        path = os.path.join(self.vault, *rel.split("/"))
        with open(path, "wb") as f:
            f.write(before.encode("utf-8"))
        status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "ALPHA")))
        self.assertEqual((status, payload["replaced"]), (200, False), payload)
        with open(path, "rb") as f:
            self.assertEqual(f.read().decode("utf-8"), before + ("\n" + linked("p_A", "ALPHA") + "\n").replace("\n", "\r\n"))

    def test_an_update_replaces_only_a_block_whose_date_line_is_its_own(self):
        rel = "Notes/Marginalia/Own.md"
        # as the app sends it: the block that links to itself is replaced in place, the user's text kept
        before = "# Own\n\n" + linked("p_A", "alpha") + "\n\n" + linked("p_B", "beta") + "\n\nMine.\n"
        self.write_note_file(rel, before)
        status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "ALPHA")))
        self.assertEqual((status, payload["replaced"]), (200, True), payload)
        self.assertEqual(self.read(rel), before.replace(linked("p_A", "alpha"), linked("p_A", "ALPHA")))
        # a block written through an obsidian:// link (the date alone) cannot prove it is A's: a fresh copy is added
        before = "# Own\n\n" + block("p_A", "alpha") + "\n\nMine.\n"
        self.write_note_file(rel, before)
        self.assert_appended_untouched(rel, before, "p_A", "ALPHA", make=linked)
        # a block whose date line links to another block is not A's either
        before = "# Own\n\n" + linked("p_A", "alpha").replace("/b1/p_A)", "/b1/p_Z)") + "\n"
        self.write_note_file(rel, before)
        self.assert_appended_untouched(rel, before, "p_A", "ALPHA", make=linked)
        # a date-alone block is still replaced by a date-alone one (the shape of a block from outside 127.0.0.1)
        before = "# Own\n\n" + block("p_A", "alpha") + "\n\nMine.\n"
        self.write_note_file(rel, before)
        status, _, payload, _ = self.post(self.note("p_A", "ALPHA", file=rel))
        self.assertEqual((status, payload["replaced"]), (200, True), payload)
        self.assertEqual(self.read(rel), before.replace(block("p_A", "alpha"), block("p_A", "ALPHA")))

    def test_an_indented_or_edited_start_marker_stops_a_replacement(self):
        rel = "Notes/Marginalia/Edited.md"
        a_open = block("p_A", "alpha").replace("\n<!-- /marginalia -->", "")       # A's end marker deleted
        for b_start in [" <!-- marginalia:p_B -->", "<!-- marginalia:p_B --> (moved)", "<!--marginalia:p_B-->",
                        "<!-- MARGINALIA:p_B -->", "- <!-- marginalia:p_B -->"]:
            with self.subTest(b_start=b_start):
                before = "# Edited\n\n" + a_open + "\n\nMine.\n\n" + block("p_B", "beta").replace("<!-- marginalia:p_B -->", b_start) + "\n"
                self.write_note_file(rel, before)
                self.assert_appended_untouched(rel, before, "p_A", "ALPHA")

    def test_a_fenced_copy_of_a_block_is_never_the_one_replaced(self):
        rel = "Notes/Marginalia/Fenced.md"
        before = ("# Fenced\n\nHow a block looks:\n\n```markdown\n" + block("p_1", "fenced example") + "\n```\n\n" +
                  block("p_1", "real one") + "\n\nafter\n")
        self.write_note_file(rel, before)
        status, _, payload, _ = self.post(self.note("p_1", "NEW", file=rel))
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["replaced"])
        self.assertEqual(self.read(rel), before.replace(block("p_1", "real one"), block("p_1", "NEW")))
        self.assertIn("fenced example", self.read(rel))

    def test_a_fence_obsidian_does_not_leave_open_never_turns_updates_into_copies(self):
        # a ``` line with no closing fence below it: Obsidian ends it with its list item, or never reads it as a fence
        rel = "Notes/Marginalia/Stray.md"
        for label, head in [
            ("a list item's fence", "- setup\n  ```sh\n  pip install x\n\nBack to prose.\n"),
            ("``` in an HTML comment", "<!-- draft:\n```\n-->\n"),
            ("``` in an HTML block", "<div>\n```\n</div>\n"),
            ("``` in $$ math", "$$\n```\n$$\n"),
            ("a list fence closed by a tab", "- item\n  ```\n  code\n\t```\n"),
        ]:
            with self.subTest(label):
                before = "# Stray\n\n" + head + "\n" + linked("p_A", "v0") + "\n\nMine.\n"
                self.write_note_file(rel, before)
                for n in range(1, 4):
                    status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "v%d" % n)))
                    self.assertEqual((status, payload["replaced"]), (200, True), payload)
                self.assertEqual(self.read(rel), before.replace(linked("p_A", "v0"), linked("p_A", "v3")))

    def test_a_linked_block_with_a_fenced_body_is_replaced_in_place(self):
        rel = "Notes/Marginalia/Code.md"
        body = "```python\nprint('<!-- x -->')\n2026-01-01\n```"
        before = "# Code\n\n" + linked("p_1", body) + "\n\n" + linked("p_2", "two") + "\n"
        self.write_note_file(rel, before)
        status, _, payload, _ = self.post(self.note("p_1", "x", file=rel, markdown=linked("p_1", "plain now")))
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["replaced"])
        self.assertEqual(self.read(rel), "# Code\n\n" + linked("p_1", "plain now") + "\n\n" + linked("p_2", "two") + "\n")

    def test_a_byte_order_mark_stays_in_front(self):
        rel = "Bom.md"
        self.write_note_file(rel, "\ufeff" + block("p_1", "old") + "\n")
        status, _, payload, _ = self.post(self.note("p_1", "new", file=rel))
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["replaced"])
        self.assertEqual(self.read(rel), "\ufeff" + block("p_1", "new") + "\n")

    def test_crlf_notes_keep_their_line_endings(self):
        path = os.path.join(self.vault, "Win.md")
        with open(path, "wb") as f:
            f.write(("# Win\n\n" + block("p_1", "old") + "\n\nafter\n").replace("\n", "\r\n").encode("utf-8"))
        status, _, payload, _ = self.post(self.note("p_1", "new", file="Win.md"))
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["replaced"])
        with open(path, "rb") as f:
            raw = f.read().decode("utf-8")
        self.assertEqual(raw, ("# Win\n\n" + block("p_1", "new") + "\n\nafter\n").replace("\n", "\r\n"))

    def test_an_update_keeps_the_notes_attributes_and_refuses_what_a_rewrite_would_break(self):
        rel = "Notes/Marginalia/Tagged.md"
        before = "# Tagged\n\nMine.\n\n" + linked("p_A", "old") + "\n"
        self.write_note_file(rel, before)
        path = os.path.join(self.vault, *rel.split("/"))
        folder = os.path.dirname(path)
        mac = sys.platform == "darwin" and shutil.which("xattr") and shutil.which("chmod")
        if mac:     # a Finder tag ("Red"), another app's attribute and an ACL entry, as a user's own note may carry
            # (the attributes are kept; the ACL is not, see keep_attributes and the deny-delete test below)
            subprocess.run(["xattr", "-wx", "com.apple.metadata:_kMDItemUserTags", "62706C6973743030A101525265640A0"
                            "80A0000000000000101000000000000000300000000000000000000000000000010", path], check=True)
            subprocess.run(["xattr", "-w", "com.example.note-id", "42", path], check=True)
            subprocess.run(["chmod", "+a", "everyone allow readextattr", path], check=True)
        os.chmod(path, 0o640)
        status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "new")))
        self.assertEqual((status, payload["replaced"]), (200, True), payload)
        self.assertEqual(self.read(rel), before.replace(linked("p_A", "old"), linked("p_A", "new")))
        self.assertEqual(os.stat(path).st_mode & 0o7777, 0o640)
        if mac:
            names = subprocess.run(["xattr", path], capture_output=True, text=True).stdout.split()
            self.assertIn("com.apple.metadata:_kMDItemUserTags", names)
            self.assertEqual(subprocess.run(["xattr", "-p", "com.example.note-id", path], capture_output=True,
                                            text=True).stdout.strip(), "42")
            self.assertNotIn("everyone allow readextattr", subprocess.run(["ls", "-le", path], capture_output=True,
                                                                          text=True).stdout)
        # refused, every byte left as it was: a read-only note, a Finder-locked one, a hard-linked one
        now = self.read(rel)
        os.chmod(path, 0o444)
        try:
            status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "newer")))
        finally:
            os.chmod(path, 0o640)
        self.assertEqual(status, 409, payload)
        self.assertIn("read-only", payload["error"])
        if mac and shutil.which("chflags"):
            subprocess.run(["chflags", "uchg", path], check=True)
            try:
                status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "newer")))
            finally:
                subprocess.run(["chflags", "nouchg", path], check=True)
            self.assertEqual((status, payload["error"][:20]), (409, "the note is read-onl"), payload)
        other = os.path.join(self.tmp, "outside", "Second name.md")
        os.link(path, other)
        status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "newer")))
        self.assertEqual(status, 409, payload)
        self.assertIn("hard-linked", payload["error"])
        self.assertEqual(os.stat(path).st_nlink, 2, "the link is not broken")
        with open(other, encoding="utf-8") as f:
            self.assertEqual((self.read(rel), f.read()), (now, now))
        self.assertEqual(sorted(os.listdir(folder)), ["Tagged.md"], "no temp file is left behind")

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("chmod"), "macOS ACLs")
    def test_a_note_whose_acl_denies_delete_fails_cleanly_without_a_stuck_temp_file(self):
        # An ACL entry "deny delete" makes the rename over the note fail. The temp file must not carry that entry,
        # or it could not be removed either and would stay in the vault as an undeletable hidden file.
        rel = "Notes/Marginalia/Guarded.md"
        before = "# Guarded\n\n" + linked("p_A", "old") + "\n"
        self.write_note_file(rel, before)
        path = os.path.join(self.vault, *rel.split("/"))
        folder = os.path.dirname(path)
        subprocess.run(["chmod", "+a", "everyone deny delete", path], check=True)
        try:
            status, _, payload, _ = self.post(self.note("p_A", "x", file=rel, markdown=linked("p_A", "new")))
            left = sorted(os.listdir(folder))
            text = self.read(rel)
        finally:
            subprocess.run(["chmod", "-N", path], check=True)
        self.assertGreaterEqual(status, 400, payload)
        self.assertFalse(payload["ok"], payload)
        self.assertEqual(left, ["Guarded.md"], "no temp file is left behind")
        self.assertEqual(text, before, "the note is unchanged")

    def test_images_land_in_the_attachment_folder_once(self):
        b64 = base64.b64encode(PNG).decode("ascii")
        status, _, payload, _ = self.post(self.note(images=[{"name": "marginalia-a_1.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        img = os.path.join(self.vault, "Attachments", "marginalia-a_1.png")
        with open(img, "rb") as f:
            self.assertEqual(f.read(), PNG)
        with open(img, "wb") as f:
            f.write(b"kept")
        status, _, payload, _ = self.post(self.note(body="again", images=[{"name": "marginalia-a_1.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        with open(img, "rb") as f:
            self.assertEqual(f.read(), b"kept", "an existing image is never replaced")

    def test_relative_attachment_folder_sits_next_to_the_note(self):
        with open(os.path.join(self.vault, ".obsidian", "app.json"), "w", encoding="utf-8") as f:
            json.dump({"attachmentFolderPath": "./img"}, f)
        b64 = base64.b64encode(PNG).decode("ascii")
        status, _, payload, _ = self.post(self.note(images=[{"name": "marginalia-a_2.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        self.assertTrue(os.path.isfile(os.path.join(self.vault, "Notes", "Marginalia", "img", "marginalia-a_2.png")))

    def test_default_attachment_folder_is_the_vault_root(self):
        os.remove(os.path.join(self.vault, ".obsidian", "app.json"))
        b64 = base64.b64encode(PNG).decode("ascii")
        status, _, payload, _ = self.post(self.note(images=[{"name": "marginalia-a_3.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        self.assertTrue(os.path.isfile(os.path.join(self.vault, "marginalia-a_3.png")))

    # ---- rejections

    def assertRejected(self, result, status):
        code, headers, payload, _ = result
        self.assertEqual(code, status, payload)
        self.assertEqual(payload.get("ok"), False)
        self.assertTrue(payload.get("error"))
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Notes")), "nothing was written")

    def test_bad_origin_is_refused(self):
        self.assertRejected(self.post(self.note(), {"Origin": "https://evil.example"}), 403)
        self.assertRejected(self.post(self.note(), {"Origin": "http://127.0.0.1:%d" % (self.port + 1)}), 403)

    def test_missing_origin_is_refused(self):
        h = {"X-Marginalia": "1", "Content-Type": "application/json"}
        self.assertRejected(self.request("POST", "/api/obsidian/note", self.note(), h), 403)

    def test_missing_marker_header_is_refused(self):
        self.assertRejected(self.post(self.note(), {"X-Marginalia": ""}), 403)

    def test_wrong_host_is_refused(self):
        self.assertRejected(self.post(self.note(), {"Host": "evil.example:%d" % self.port}), 403)
        status, _, payload, _ = self.request("GET", "/api/obsidian/vaults", headers={"Host": "rebind.example"})
        self.assertEqual(status, 403, payload)

    def test_wrong_content_type_is_refused(self):
        self.assertRejected(self.post(self.note(), {"Content-Type": "text/plain"}), 415)

    def test_parent_path_is_refused(self):
        self.assertRejected(self.post(self.note(file="../x.md")), 400)
        self.assertRejected(self.post(self.note(file="Notes/../../x.md")), 400)
        self.assertEqual(self.files_outside(), [])

    def test_absolute_path_is_refused(self):
        self.assertRejected(self.post(self.note(file=os.path.join(self.outside, "x.md"))), 400)
        self.assertEqual(self.files_outside(), [])

    def test_non_markdown_and_odd_paths_are_refused(self):
        self.assertRejected(self.post(self.note(file="Notes/x.txt")), 400)
        self.assertRejected(self.post(self.note(file="Notes\\x.md")), 400)
        self.assertRejected(self.post(self.note(file="Notes/\u0000x.md")), 400)

    def test_unknown_vault_is_refused(self):
        self.assertRejected(self.post(self.note(vault="Other Vault")), 400)
        self.assertRejected(self.post(self.note(vault="Missing Vault")), 400)

    def test_bad_image_name_is_refused(self):
        b64 = base64.b64encode(PNG).decode("ascii")
        for name in ["../marginalia-a.png", "marginalia-a.svg", "photo.png", "marginalia-a/b.png", "marginalia-.png",
                     "marginalia-a.png\n", "marginalia-a.png\r", " marginalia-a.png", "marginalia-a.png\x00"]:
            with self.subTest(name=name):
                self.assertRejected(self.post(self.note(images=[{"name": name, "data": b64}])), 400)
        self.assertRejected(self.post(self.note(images=[{"name": "marginalia-a.png", "data": "not base64!"}])), 400)
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Attachments")), "no image was written")

    def test_block_id_must_be_the_whole_string(self):
        for pid in ["p_1\n", "p_1 ", "p/1", ""]:
            with self.subTest(pid=pid):
                self.assertRejected(self.post(self.note(blockId=pid)), 400)

    def test_markdown_must_be_one_block(self):
        self.assertRejected(self.post(self.note(markdown="no markers")), 400)
        self.assertRejected(self.post(self.note(markdown=block("p_9", "x"))), 400)
        self.assertRejected(self.post(self.note(markdown=block("p_1", block("p_2", "x")))), 400)

    def test_markdown_must_be_a_block_the_next_send_can_find(self):
        for label, md in [
            ("loose marker inside", block("p_1", " <!-- marginalia:p_2 -->")),
            ("edited end marker inside", block("p_1", "<!--/marginalia-->")),
            ("no date line", block("p_1", "x").replace("\n2026-11-06\n", "\n")),
            ("a second date line", block("p_1", "2026-01-01")),
            ("date line not last", block("p_1", "x").replace("\n2026-11-06\n", "\n2026-11-06\n\nmore\n")),
            ("code fence left open", block("p_1", "```\ncode")),
        ]:
            with self.subTest(label):
                self.assertRejected(self.post(self.note(markdown=md)), 400)
        # what the app sends is accepted: an escaped date in the body, a closed fence (with a date line inside it)
        status, _, payload, _ = self.post(self.note(markdown=linked("p_1", "2026\\-01-01\n```\n2026-01-01\n```")))
        self.assertEqual(status, 200, payload)

    def test_text_that_is_not_valid_unicode_is_a_json_error_and_writes_nothing(self):
        b64 = base64.b64encode(PNG).decode("ascii")
        img = [{"name": "marginalia-a_1.png", "data": b64}]
        for label, extra in [
            ("markdown", {"markdown": block("p_1", "a lone \ud835 surrogate"), "images": img}),
            ("quote", {"markdown": block("p_1", "x").replace("> a quote", "> " + "a" * 499 + "\ud835"), "images": img}),
            ("file", {"file": "Notes/\ud800.md", "images": img}),
            ("title", {"title": "Book \udc00", "images": img}),
            ("vault", {"vault": "Test Vault\ud800"}),
            ("image name", {"images": [{"name": "marginalia-\ud800.png", "data": b64}]}),
        ]:
            with self.subTest(label):
                status, _, payload, _ = self.post(self.note(**extra))
                self.assertEqual(status, 400, payload)
                self.assertEqual(payload.get("ok"), False)
                self.assertTrue(payload.get("error"))
                self.assertEqual(os.listdir(self.vault), [".obsidian"], "no note, folder or image was written")

    def test_unexpected_errors_still_answer_with_json(self):
        def boom(*args, **kwargs):
            raise RuntimeError("simulated failure")
        saved = serve.write_note, serve.public_vaults, serve.write_notes, serve.write_backup, serve.backup_listing
        serve.write_note = serve.public_vaults = serve.write_notes = serve.write_backup = serve.backup_listing = boom
        try:
            status, headers, payload, _ = self.post(self.note())
            self.assertEqual((status, payload), (500, {"ok": False, "error": "unexpected error"}))
            self.assertEqual(headers.get("cache-control"), "no-store")
            status, _, payload, raw = self.request("GET", "/api/obsidian/vaults")
            self.assertEqual((status, payload), (500, {"ok": False, "error": "unexpected error"}))
            self.assertNotIn(b"simulated", raw, "no traceback or message reaches the client")
            status, _, payload, raw = self.post_notes(self.notes([("p_1", linked("p_1", "x"))]))
            self.assertEqual((status, payload), (500, {"ok": False, "error": "unexpected error"}))
            status, _, payload, raw = self.request("GET", "/api/backup")
            self.assertEqual((status, payload), (500, {"ok": False, "error": "unexpected error"}))
            status, _, payload, raw = self.request("POST", "/api/backup", b'{"mode": "auto", "backup": {}}',
                                                   post_headers(self.port))
            self.assertEqual((status, payload), (500, {"ok": False, "error": "unexpected error"}))
            self.assertNotIn(b"simulated", raw)
        finally:
            (serve.write_note, serve.public_vaults, serve.write_notes, serve.write_backup,
             serve.backup_listing) = saved
        self.assertEqual(self.request("GET", "/api/obsidian/vaults")[0], 200, "the server keeps serving")

    def test_a_body_nested_too_deep_still_gets_a_json_answer(self):
        h = {"Origin": "http://127.0.0.1:%d" % self.port, "X-Marginalia": "1", "Content-Type": "application/json"}
        status, _, payload, _ = self.request("POST", "/api/obsidian/note", b"[" * 200000 + b"]" * 200000, h)
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload.get("ok"), False)

    # ---- clients that are not this machine

    def via_socket(self, client, method, path, body=None, headers=None):
        return via_socket(self.httpd, client, method, path, body, headers)

    def test_the_api_answers_only_this_machine(self):
        headers = post_headers(self.port)
        backup = {"mode": "manual", "backup": {"format": "marginalia", "version": 1, "collections": [], "prompts": []}}
        for addr in ["192.168.1.20", "10.0.0.5", "8.8.8.8", "fe80::1", "::ffff:192.168.1.20"]:
            with self.subTest(addr=addr):
                status, payload = self.via_socket((addr, 50000), "GET", "/api/obsidian/vaults")
                self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden client"}))
                status, payload = self.via_socket((addr, 50000), "POST", "/api/obsidian/note", self.note(), headers)
                self.assertEqual(status, 403, payload)
                status, payload = self.via_socket((addr, 50000), "POST", "/api/obsidian/notes",
                                                  self.notes([("p_1", linked("p_1", "x"))]), headers)
                self.assertEqual(status, 403, payload)
                status, payload = self.via_socket((addr, 50000), "GET", "/api/backup")
                self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden client"}))
                status, payload = self.via_socket((addr, 50000), "POST", "/api/backup", backup, headers)
                self.assertEqual(status, 403, payload)
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Notes")), "nothing was written")
        self.assertFalse(os.path.exists(self.backups), "no backup was written")
        # the same path from loopback works, so the refusals above are about the address
        status, payload = self.via_socket(("127.0.0.1", 50000), "GET", "/api/obsidian/vaults")
        self.assertEqual(status, 200, payload)
        self.assertEqual([v["name"] for v in payload["vaults"]], ["Test Vault"])
        status, payload = self.via_socket(("::1", 50000, 0, 0), "POST", "/api/obsidian/note", self.note(), headers)
        self.assertEqual(status, 200, payload)
        status, payload = self.via_socket(("::1", 50000, 0, 0), "POST", "/api/obsidian/notes",
                                          self.notes([("p_2", linked("p_2", "x"))]), headers)
        self.assertEqual(status, 200, payload)
        status, payload = self.via_socket(("127.0.0.1", 50000), "GET", "/api/backup")
        self.assertEqual((status, payload["files"]), (200, []), payload)

    def test_symlink_inside_the_vault_pointing_outside_is_refused(self):
        os.symlink(self.outside, os.path.join(self.vault, "Linked"))
        self.assertRejected(self.post(self.note(file="Linked/x.md")), 403)
        os.symlink(os.path.join(self.outside, "target.md"), os.path.join(self.vault, "Note link.md"))
        result = self.post(self.note(file="Note link.md"))
        self.assertEqual(result[0], 403, result[2])
        self.assertEqual(self.files_outside(), [])

    def test_attachment_symlink_pointing_outside_is_refused(self):
        os.symlink(self.outside, os.path.join(self.vault, "Attachments"))
        b64 = base64.b64encode(PNG).decode("ascii")
        self.assertRejected(self.post(self.note(images=[{"name": "marginalia-a_4.png", "data": b64}])), 403)
        self.assertEqual(self.files_outside(), [])

    def test_only_the_api_routes_exist(self):
        status, headers, _, _ = self.request("GET", "/api/obsidian/note")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get("cache-control"), "no-store")
        h = post_headers(self.port)
        self.assertEqual(self.request("POST", "/api/obsidian/vaults", {}, h)[0], 404)
        self.assertEqual(self.request("GET", "/api/obsidian/notes")[0], 404)
        self.assertEqual(self.request("GET", "/api/backup/")[0], 404)
        self.assertEqual(self.request("GET", "/api/anything")[0], 404)
        self.assertEqual(self.request("HEAD", "/api/obsidian/vaults")[0], 404)
        self.assertEqual(self.request("HEAD", "/api/backup")[0], 404)
        status, headers, _, _ = self.request("OPTIONS", "/api/obsidian/note", headers={"Origin": "https://evil.example",
                                                                                       "Access-Control-Request-Method": "POST"})
        self.assertEqual(status, 501, "no OPTIONS handling")
        self.assertNotIn("access-control-allow-origin", headers)
        for path in ("/api/obsidian/note", "/api/obsidian/notes", "/api/backup"):
            self.assertEqual(self.request("PUT", path, b"{}", h)[0], 501)
            self.assertEqual(self.request("DELETE", path, None, h)[0], 501)

    def test_oversized_body_is_refused_without_reading_it(self):
        self.assertEqual(oversized(self.port, "/api/obsidian/note", serve.MAX_BODY + 1), 413)
        self.assertEqual(oversized(self.port, "/api/obsidian/notes", serve.MAX_NOTES_BODY + 1), 413)
        self.assertEqual(oversized(self.port, "/api/backup", serve.MAX_BACKUP_BODY + 1), 413)
        self.assertEqual((serve.MAX_BODY, serve.MAX_NOTES_BODY, serve.MAX_BACKUP_BODY),
                         (25 * 1024 * 1024, 100 * 1024 * 1024, 512 * 1024 * 1024))

    def test_every_post_route_has_the_same_guards(self):
        bodies = {"/api/obsidian/note": self.note(), "/api/obsidian/notes": self.notes([("p_1", linked("p_1", "x"))]),
                  "/api/backup": {"mode": "manual", "backup": {"format": "marginalia", "version": 1,
                                                               "collections": [], "prompts": []}}}
        for path, body in bodies.items():
            for label, headers, status in [
                ("another site", {"Origin": "https://evil.example"}, 403),
                ("another port", {"Origin": "http://127.0.0.1:%d" % (self.port + 1)}, 403),
                ("no X-Marginalia", {"X-Marginalia": ""}, 403),
                ("DNS rebinding", {"Host": "evil.example:%d" % self.port}, 403),
                ("a form post", {"Content-Type": "text/plain"}, 415),
                ("a form post", {"Content-Type": "application/x-www-form-urlencoded"}, 415),
            ]:
                with self.subTest(path=path, label=label):
                    h = post_headers(self.port)
                    h.update(headers)
                    code, answer_headers, payload, _ = self.request("POST", path, body, h)
                    self.assertEqual(code, status, payload)
                    self.assertEqual(payload.get("ok"), False)
                    self.assertNotIn("access-control-allow-origin", answer_headers)
            h = post_headers(self.port)
            del h["Origin"]
            self.assertEqual(self.request("POST", path, body, h)[0], 403, "no Origin: " + path)
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Notes")), "nothing was written")
        self.assertFalse(os.path.exists(self.backups), "no backup was written")

    # ---- send all (POST /api/obsidian/notes)

    def test_send_all_creates_the_note_with_every_block_in_order(self):
        blocks = [(p, linked(p, "text of " + p)) for p in ("p_3", "p_1", "p_2")]
        status, headers, payload, _ = self.post_notes(self.notes(blocks))
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(payload, {"ok": True, "file": "Notes/Marginalia/Book One.md", "created": True,
                                   "results": [{"blockId": p, "ok": True, "replaced": False} for p, _ in blocks]})
        expected = "# Book One\n\n" + "\n\n".join(md for _, md in blocks) + "\n"
        self.assertEqual(self.read("Notes/Marginalia/Book One.md"), expected)
        for p, md in blocks:                                       # the same note as one single send after another
            self.post(self.note(p, file="Notes/Single.md", markdown=md))
        self.assertEqual(self.read("Notes/Single.md"), expected)

    def test_send_all_updates_blocks_in_place_and_adds_new_ones(self):
        rel = "Notes/Marginalia/Book One.md"
        before = ("# Book One\n\nMy intro.\n\n" + linked("p_1", "one") + "\n\n" + linked("p_2", "two") +
                  "\n\nMy closing words.\n")
        self.write_note_file(rel, before)
        self.write_note_file("Copy.md", before)
        blocks = [("p_2", linked("p_2", "TWO")), ("p_3", linked("p_3", "three")), ("p_1", linked("p_1", "ONE\nmore"))]
        status, _, payload, _ = self.post_notes(self.notes(blocks))
        self.assertEqual(status, 200, payload)
        self.assertIs(payload["created"], False)
        self.assertEqual([(r["blockId"], r["ok"], r["replaced"]) for r in payload["results"]],
                         [("p_2", True, True), ("p_3", True, False), ("p_1", True, True)])
        after = ("# Book One\n\nMy intro.\n\n" + linked("p_1", "ONE\nmore") + "\n\n" + linked("p_2", "TWO") +
                 "\n\nMy closing words.\n\n" + linked("p_3", "three") + "\n")
        self.assertEqual(self.read(rel), after)
        for p, md in blocks:                                       # what one single send after another leaves
            status, _, single, _ = self.post(self.note(p, file="Copy.md", markdown=md))
            self.assertEqual(status, 200, single)
        self.assertEqual(self.read("Copy.md"), after)
        # sending the whole book again changes nothing and updates every block in place
        status, _, payload, _ = self.post_notes(self.notes(blocks))
        self.assertEqual([r["replaced"] for r in payload["results"]], [True, True, True])
        self.assertEqual(self.read(rel), after)

    def test_send_all_reports_invalid_blocks_and_writes_the_others(self):
        blocks = [
            {"blockId": "p_1", "markdown": linked("p_1", "fine")},
            {"blockId": "p 2", "markdown": linked("p 2", "x")},
            {"blockId": "p_3", "markdown": "no markers"},
            {"blockId": "p_4", "markdown": linked("p_5", "the markers of another block")},
            {"blockId": "p_6", "markdown": block("p_6", "x").replace("\n2026-11-06\n", "\n")},
            {"blockId": "p_7", "markdown": linked("p_7", "a lone \ud835 surrogate")},
            "not a block",
            {"markdown": linked("p_8", "no blockId")},
            {"blockId": "p_9", "markdown": block("p_9", "```\nan open fence")},
            {"blockId": "p_10", "markdown": linked("p_10", "also fine")},
        ]
        status, _, payload, _ = self.post_notes(self.notes(blocks))
        self.assertEqual(status, 200, payload)
        results = payload["results"]
        self.assertEqual(len(results), len(blocks))
        self.assertEqual([r["ok"] for r in results], [True, False, False, False, False, False, False, False, False, True])
        self.assertEqual([r["blockId"] for r in results],
                         ["p_1", "p 2", "p_3", "p_4", "p_6", "p_7", None, None, "p_9", "p_10"])
        self.assertEqual(results[1]["error"], "bad blockId")
        self.assertIn("between its marginalia markers", results[2]["error"])
        self.assertIn("between its marginalia markers", results[3]["error"])
        self.assertIn("date line", results[4]["error"])
        self.assertIn("not valid Unicode", results[5]["error"])
        self.assertIn("blockId and markdown", results[6]["error"])
        self.assertEqual(results[7]["error"], "bad blockId")
        self.assertIn("code fence", results[8]["error"])
        for r in results:
            self.assertEqual(set(r), {"blockId", "ok", "replaced"} if r["ok"] else {"blockId", "ok", "error"})
        self.assertEqual(self.read("Notes/Marginalia/Book One.md"),
                         "# Book One\n\n" + linked("p_1", "fine") + "\n\n" + linked("p_10", "also fine") + "\n")

    def test_send_all_without_a_valid_block_writes_nothing(self):
        status, _, payload, _ = self.post_notes(self.notes([("p_1", "no markers"), ("p_2", block("p_3", "x"))]))
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload["ok"], False)
        self.assertTrue(payload["error"].startswith("no block could be written: "), payload)
        self.assertEqual([(r["blockId"], r["ok"]) for r in payload["results"]], [("p_1", False), ("p_2", False)])
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Notes")), "nothing was written")

    def test_send_all_refuses_a_block_id_given_twice(self):
        rel = "Notes/Marginalia/Book One.md"
        before = "# Book One\n\n" + linked("p_1", "old") + "\n"
        self.write_note_file(rel, before)
        for blocks in ([("p_1", linked("p_1", "a")), ("p_2", linked("p_2", "b")), ("p_1", linked("p_1", "c"))],
                       [("p_2", linked("p_2", "b")), ("p_2", "not even a block")]):
            with self.subTest(blocks=[b[0] for b in blocks]):
                status, _, payload, _ = self.post_notes(self.notes(blocks))
                self.assertEqual(status, 400, payload)
                self.assertIn("twice", payload["error"])
                self.assertEqual(self.read(rel), before, "nothing was written")

    def test_send_all_reads_the_note_once_and_writes_it_once(self):
        rel = "Notes/Marginalia/Book One.md"
        self.write_note_file(rel, "# Book One\n\n" + linked("p_1", "old") + "\n\n" + linked("p_3", "old") + "\n")
        b64 = base64.b64encode(PNG).decode("ascii")
        writes, reads = [], []
        saved = serve.atomic_write, serve.read_for_update

        def counting_write(path, data, mode=None, keep_from=None, **kw):
            writes.append(path)
            return saved[0](path, data, mode, keep_from, **kw)

        def counting_read(target):
            reads.append(target)
            return saved[1](target)
        serve.atomic_write, serve.read_for_update = counting_write, counting_read
        try:
            status, _, payload, _ = self.post_notes(self.notes(
                [(p, linked(p, "new " + p)) for p in ("p_1", "p_2", "p_3", "p_4")],
                images=[{"name": "marginalia-a_1.png", "data": b64}, {"name": "marginalia-a_1.png", "data": b64}]))
        finally:
            serve.atomic_write, serve.read_for_update = saved
        self.assertEqual(status, 200, payload)
        self.assertEqual([r["replaced"] for r in payload["results"]], [True, False, True, False])
        self.assertEqual([os.path.basename(p) for p in writes], ["marginalia-a_1.png", "Book One.md"],
                         "the image, then the note once")
        self.assertEqual(len(reads), 1, "the note is read once")
        self.assertEqual(sorted(os.listdir(os.path.dirname(writes[-1]))), ["Book One.md"], "no temp file is left")

    def test_send_all_keeps_line_ends_byte_order_mark_mode_and_attributes(self):
        rel = "Notes/Marginalia/Kept.md"
        path = os.path.join(self.vault, *rel.split("/"))
        os.makedirs(os.path.dirname(path))
        crlf = lambda t: t.replace("\n", "\r\n")
        before = "\ufeff" + crlf("# Kept\n\nMine.\n\n" + linked("p_A", "old") + "\n\nMore of mine.\n")
        with open(path, "wb") as f:
            f.write(before.encode("utf-8"))
        os.chmod(path, 0o640)
        mac = sys.platform == "darwin" and shutil.which("xattr")
        if mac:
            subprocess.run(["xattr", "-w", "com.example.note-id", "42", path], check=True)
        status, _, payload, _ = self.post_notes(self.notes([("p_A", linked("p_A", "new\nlines")),
                                                            ("p_B", linked("p_B", "added"))], file=rel, title="Kept"))
        self.assertEqual(status, 200, payload)
        self.assertEqual([r["replaced"] for r in payload["results"]], [True, False])
        with open(path, "rb") as f:
            raw = f.read().decode("utf-8")
        self.assertEqual(raw, before.replace(crlf(linked("p_A", "old")), crlf(linked("p_A", "new\nlines"))) +
                         crlf("\n" + linked("p_B", "added") + "\n"))
        self.assertEqual(os.stat(path).st_mode & 0o7777, 0o640)
        if mac:
            self.assertEqual(subprocess.run(["xattr", "-p", "com.example.note-id", path], capture_output=True,
                                            text=True).stdout.strip(), "42")

    def test_send_all_refuses_read_only_and_hard_linked_notes(self):
        rel = "Notes/Marginalia/Book One.md"
        before = "# Book One\n\n" + linked("p_1", "old") + "\n"
        self.write_note_file(rel, before)
        path = os.path.join(self.vault, *rel.split("/"))
        request = self.notes([("p_1", linked("p_1", "new")), ("p_2", linked("p_2", "added"))])
        os.chmod(path, 0o444)
        try:
            status, _, payload, _ = self.post_notes(request)
        finally:
            os.chmod(path, 0o644)
        self.assertEqual(status, 409, payload)
        self.assertIn("read-only", payload["error"])
        other = os.path.join(self.outside, "Second name.md")
        os.link(path, other)
        status, _, payload, _ = self.post_notes(request)
        self.assertEqual(status, 409, payload)
        self.assertIn("hard-linked", payload["error"])
        with open(other, encoding="utf-8") as f:
            self.assertEqual((self.read(rel), f.read()), (before, before))
        self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ["Book One.md"], "no temp file is left behind")

    # ---- a save that lands while a send runs (an edit in Obsidian, a sync)

    @contextlib.contextmanager
    def saves_before_the_write(self, path, saves=1, how="append"):
        """Another app saves the note after the server has read it and made the new text, right before the server
        writes it (write_images runs just before the note's write): in place, as Obsidian saves ("append"), by putting
        a new file in its place, as a sync does ("replace"), or by making it ("create"); or `how` is a function that
        changes the note at `path` itself. The first `saves` writes get one save each; -> the list of saves made."""
        saved = serve.write_images
        done = []

        def write_images(*args):
            if len(done) < saves:
                done.append("Typed in Obsidian %d." % (len(done) + 1))
                if how == "append":
                    with open(path, "a", encoding="utf-8") as f:
                        f.write("\n" + done[-1] + "\n")
                elif how == "replace":
                    with open(path, encoding="utf-8") as f:
                        old = f.read()
                    with open(path + ".sync", "w", encoding="utf-8") as f:
                        f.write(old + "\n" + done[-1] + "\n")
                    os.replace(path + ".sync", path)
                elif how == "lock":
                    os.chmod(path, 0o444)
                elif callable(how):
                    how(path)
                else:
                    with open(path, "x", encoding="utf-8") as f:
                        f.write("# Mine\n\n" + done[-1] + "\n")
            return saved(*args)
        serve.write_images = write_images
        try:
            yield done
        finally:
            serve.write_images = saved

    def test_a_save_that_lands_during_a_send_is_never_overwritten(self):
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        start = "# Book One\n\nMy intro.\n\n" + linked("p_1", "one") + "\n\n" + linked("p_2", "two") + "\n"
        items = [("p_1", linked("p_1", "ONE")), ("p_3", linked("p_3", "three"))]
        for route, how in [("notes", "append"), ("notes", "replace"), ("note", "append"), ("note", "replace")]:
            with self.subTest(route=route, how=how):
                self.write_note_file(rel, start)
                with self.saves_before_the_write(path, 1, how) as saves:
                    if route == "notes":
                        status, _, payload, _ = self.post_notes(self.notes(items))
                    else:
                        status, _, payload, _ = self.post(self.note("p_1", file=rel, markdown=items[0][1]))
                self.assertEqual(status, 200, payload)
                self.assertEqual(len(saves), 1)
                user = start + "\n" + saves[0] + "\n"             # the note as the other app saved it
                sent = items if route == "notes" else items[:1]
                expected = serve.upsert_blocks(user, [(serve.check_block(md, p), p) for p, md in sent])[0]
                self.assertEqual(self.read(rel), expected, "the save is kept, and every block went in")
                self.assertEqual(self.read(rel).count("Typed in Obsidian"), 1)
                self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ["Book One.md"], "no temp file is left")

    def test_a_note_made_by_another_app_during_its_first_send_is_kept(self):
        for route in ("notes", "note"):
            with self.subTest(route=route):
                rel = "Notes/First %s.md" % route
                path = os.path.join(self.vault, *rel.split("/"))
                with self.saves_before_the_write(path, 1, "create"):
                    if route == "notes":
                        status, _, payload, _ = self.post_notes(self.notes([("p_1", linked("p_1", "x"))], file=rel))
                    else:
                        status, _, payload, _ = self.post(self.note("p_1", file=rel, markdown=linked("p_1", "x")))
                self.assertEqual(status, 200, payload)
                self.assertIs(payload["created"], False, "the second look found the other app's note")
                self.assertEqual(self.read(rel), "# Mine\n\nTyped in Obsidian 1.\n\n" + linked("p_1", "x") + "\n")

    def test_a_note_that_keeps_changing_is_left_as_it_is(self):
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        start = "# Book One\n\n" + linked("p_1", "one") + "\n"
        b64 = base64.b64encode(PNG).decode("ascii")
        for route in ("notes", "note"):
            with self.subTest(route=route):
                self.write_note_file(rel, start)
                with self.saves_before_the_write(path, serve.NOTE_TRIES) as saves:
                    if route == "notes":
                        status, _, payload, _ = self.post_notes(self.notes(
                            [("p_1", linked("p_1", "NEW")), ("p_2", linked("p_2", "added"))],
                            images=[{"name": "marginalia-a_1.png", "data": b64}]))
                    else:
                        status, _, payload, _ = self.post(self.note("p_1", file=rel, markdown=linked("p_1", "NEW")))
                self.assertEqual((status, payload), (409, {"ok": False, "error": serve.NOTE_CHANGED}))
                self.assertEqual(len(saves), serve.NOTE_TRIES, "read again after each save, then given up")
                self.assertEqual(self.read(rel), start + "".join("\n%s\n" % s for s in saves), "only the saves")
                self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ["Book One.md"], "no temp file is left")
        with open(os.path.join(self.vault, "Attachments", "marginalia-a_1.png"), "rb") as f:
            self.assertEqual(f.read(), PNG, "the image was written once")

    def test_a_note_made_read_only_during_a_send_is_not_rewritten(self):
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        start = "# Book One\n\n" + linked("p_1", "one") + "\n"
        for route in ("notes", "note"):
            with self.subTest(route=route):
                self.write_note_file(rel, start)
                try:
                    with self.saves_before_the_write(path, 1, "lock"):
                        if route == "notes":
                            status, _, payload, _ = self.post_notes(self.notes([("p_1", linked("p_1", "NEW"))]))
                        else:
                            status, _, payload, _ = self.post(self.note("p_1", file=rel, markdown=linked("p_1", "NEW")))
                    self.assertEqual(status, 409, payload)
                    self.assertIn("read-only", payload["error"])
                    self.assertEqual(self.read(rel), start)
                    self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o444)
                finally:
                    os.chmod(path, 0o644)

    def test_a_save_of_the_same_size_within_the_same_file_time_is_seen(self):
        # a disk with coarse file times (HFS+, FAT, some network disks): the size and the time stay, the bytes do not
        path = os.path.join(self.tmp, "note.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# T\n\nabc\n")
        text, mode, seen = serve.read_for_update(path)
        self.assertEqual(text, "# T\n\nabc\n")
        self.assertTrue(serve.note_unchanged(path, seen))
        st = os.stat(path)
        with open(path, "r+", encoding="utf-8") as f:
            f.write("# T\n\nxyz\n")
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(serve.file_state(os.stat(path)), seen[0], "the same size and time")
        self.assertFalse(serve.note_unchanged(path, seen))
        os.remove(path)
        self.assertFalse(serve.note_unchanged(path, seen))
        self.assertTrue(serve.note_unchanged(path, None), "no note then, and none now")
        with open(path, "w", encoding="utf-8") as f:
            f.write("")
        self.assertFalse(serve.note_unchanged(path, None))

    def test_send_all_writes_images_once_and_refuses_bad_ones(self):
        b64 = base64.b64encode(PNG).decode("ascii")
        img = os.path.join(self.vault, "Attachments", "marginalia-a_1.png")
        self.assertRejected(self.post_notes(self.notes([("p_1", linked("p_1", "x"))],
                                                       images=[{"name": "../marginalia-a_1.png", "data": b64}])), 400)
        self.assertRejected(self.post_notes(self.notes([("p_1", linked("p_1", "x"))],
                                                       images=[{"name": "marginalia-a_1.png", "data": "no!"}])), 400)
        status, _, payload, _ = self.post_notes(self.notes([("p_1", linked("p_1", "![[marginalia-a_1.png]]"))],
                                                           images=[{"name": "marginalia-a_1.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        with open(img, "rb") as f:
            self.assertEqual(f.read(), PNG)
        with open(img, "wb") as f:
            f.write(b"kept")
        status, _, payload, _ = self.post_notes(self.notes([("p_1", linked("p_1", "again"))],
                                                           images=[{"name": "marginalia-a_1.png", "data": b64}]))
        self.assertEqual(status, 200, payload)
        with open(img, "rb") as f:
            self.assertEqual(f.read(), b"kept", "an existing image is never replaced")

    def test_send_all_request_errors_write_nothing(self):
        one = [("p_1", linked("p_1", "x"))]
        for label, payload, status in [
            ("not an object", ["x"], 400),
            ("no blocks", self.notes([]), 400),
            ("blocks not a list", dict(self.notes(one), blocks={"p_1": "x"}), 400),
            ("too many blocks", self.notes([("p_%d" % i, linked("p_%d" % i, "x")) for i in range(serve.MAX_BLOCKS + 1)]), 400),
            ("unknown vault", self.notes(one, vault="Other Vault"), 400),
            ("a parent path", self.notes(one, file="../x.md"), 400),
            ("not markdown", self.notes(one, file="Notes/x.txt"), 400),
            ("an absolute path", self.notes(one, file=os.path.join(self.outside, "x.md")), 400),
            ("a file that is not Unicode", self.notes(one, file="Notes/\ud800.md"), 400),
            ("a title that is not Unicode", self.notes(one, title="Book \udc00"), 400),
        ]:
            with self.subTest(label):
                self.assertRejected(self.post_notes(payload), status)
        self.assertEqual(self.files_outside(), [])
        os.symlink(self.outside, os.path.join(self.vault, "Linked"))
        self.assertRejected(self.post_notes(self.notes(one, file="Linked/x.md")), 403)
        self.assertEqual(self.files_outside(), [])
        one_dir, two_dir = os.path.join(self.tmp, "one", "Same"), os.path.join(self.tmp, "two", "Same")
        for d in (one_dir, two_dir):
            os.makedirs(d)
        self.write_config({"old111": {"path": one_dir, "ts": 1, "open": True}, "new222": {"path": two_dir, "ts": 2}})
        status, _, payload, _ = self.post_notes(self.notes(one, vault="Same"))
        self.assertEqual(status, 409, payload)
        self.assertEqual((os.listdir(one_dir), os.listdir(two_dir)), ([], []))

    def test_send_all_takes_the_most_blocks_in_one_request(self):
        rel = "Notes/Marginalia/Big.md"
        fenced_body = "Q. what does it print?\nA. two lines\n```py\nprint(1)\nprint(2)\n```"
        blocks = [("p_%d" % i, linked("p_%d" % i, fenced_body if i % 3 == 0 else "text %d" % i))
                  for i in range(serve.MAX_BLOCKS)]
        t = time.perf_counter()
        status, _, payload, _ = self.post_notes(self.notes(blocks, file=rel, title="Big"))
        self.assertEqual(status, 200, payload)
        self.assertTrue(all(r["ok"] and not r["replaced"] for r in payload["results"]))
        blocks = [(p, md.replace("text", "TEXT")) for p, md in reversed(blocks)]
        status, _, payload, _ = self.post_notes(self.notes(blocks, file=rel, title="Big"))
        elapsed = time.perf_counter() - t
        self.assertEqual(status, 200, payload)
        self.assertTrue(all(r["ok"] and r["replaced"] for r in payload["results"]))
        text = self.read(rel)
        self.assertEqual(text.count("<!-- marginalia:"), serve.MAX_BLOCKS)
        self.assertNotIn("text 1\n", text)
        self.assertLess(elapsed, 30.0, "2 x 2000 blocks (it took about 2 s; one /note request each took minutes)")

    # ---- send all, replaceOnly (A8: a card sent before and edited since is updated in place, never sent twice)

    @staticmethod
    def edited(pid, md):
        """A card sent before and edited since: the page sends its block with "replaceOnly": true."""
        return {"blockId": pid, "markdown": md, "replaceOnly": True}

    @staticmethod
    def gone(pid):
        return {"blockId": pid, "ok": False, "notFound": True, "error": "its earlier copy is no longer in the note"}

    def note_state(self, rel):
        """(bytes, inode, modification time) of a note: any write shows, also one of the same text (a new inode)."""
        path = os.path.join(self.vault, *rel.split("/"))
        with open(path, "rb") as f:
            raw = f.read()
        st = os.stat(path)
        return raw, st.st_ino, st.st_mtime_ns

    def test_send_all_replace_only_updates_the_copy_the_note_holds(self):
        rel = "Notes/Marginalia/Book One.md"
        before = ("# Book One\n\nMy intro.\n\n" + linked("p_1", "one") + "\n\n" + linked("p_2", "two") +
                  "\n\nMy closing words.\n")
        self.write_note_file(rel, before)
        status, _, payload, _ = self.post_notes(self.notes([self.edited("p_2", linked("p_2", "TWO\nmore")),
                                                            self.edited("p_1", linked("p_1", "ONE"))]))
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload, {"ok": True, "file": rel, "created": False,
                                   "results": [{"blockId": "p_2", "ok": True, "replaced": True},
                                               {"blockId": "p_1", "ok": True, "replaced": True}]})
        self.assertEqual(self.read(rel), before.replace(linked("p_2", "two"), linked("p_2", "TWO\nmore"))
                         .replace(linked("p_1", "one"), linked("p_1", "ONE")))

    def test_send_all_replace_only_never_adds_a_card_whose_copy_is_gone(self):
        rel = "Notes/Marginalia/Book One.md"
        one, two, three = linked("p_1", "one"), linked("p_2", "two"), linked("p_3", "three")
        date2 = "[Open in Marginalia](http://127.0.0.1:8765/#reader/b1/p_2) · 2026-11-06"
        start2, end = "<!-- marginalia:p_2 -->", "\n<!-- /marginalia -->"
        head = "# Book One\n\n" + one + "\n\n"
        cases = [
            ("deleted", head + three + "\n"),
            ("start marker edited", head + two.replace(start2, start2 + " mine") + "\n"),
            ("start marker indented", head + two.replace(start2, "  " + start2) + "\n"),
            ("start marker deleted", head + two.replace(start2 + "\n", "") + "\n"),
            ("end marker deleted", head + two.replace(end, "") + "\n\nMy text.\n\n" + three + "\n"),
            ("date line edited", head + two.replace(date2, date2 + " #seen") + "\n"),
            ("date line deleted", head + two.replace(date2 + "\n", "") + "\n"),
            ("two blocks merged by hand", head + two.replace(end, "") + "\n"
             + three.replace("<!-- marginalia:p_3 -->\n", "") + "\n"),
            ("sent through an obsidian:// link (the date alone)", head + block("p_2", "two") + "\n"),
            ("only a copy inside a code fence", head + "```\n" + two + "\n```\n"),
        ]
        for label, before in cases:
            with self.subTest(label):
                self.write_note_file(rel, before)
                state = self.note_state(rel)
                status, _, payload, _ = self.post_notes(self.notes([self.edited("p_2", linked("p_2", "TWO"))]))
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload, {"ok": True, "file": rel, "created": False, "results": [self.gone("p_2")]})
                self.assertEqual(self.note_state(rel), state, "the note was not written at all")
                # what an update without replaceOnly (a single send) does here: a second copy at the end
                self.assertEqual(serve.upsert_text(before, linked("p_2", "TWO"), "p_2"),
                                 (before + "\n" + linked("p_2", "TWO") + "\n", False))
        self.assertEqual(sorted(os.listdir(os.path.join(self.vault, "Notes", "Marginalia"))), ["Book One.md"],
                         "no temp file is left")

    def test_send_all_replace_only_into_a_missing_note_writes_nothing(self):
        rel = "Notes/Marginalia/Book One.md"
        b64 = base64.b64encode(PNG).decode("ascii")
        request = self.notes([self.edited("p_1", linked("p_1", "![[marginalia-a_1.png]]")),
                              self.edited("p_2", linked("p_2", "two"))],
                             images=[{"name": "marginalia-a_1.png", "data": b64}])
        status, headers, payload, _ = self.post_notes(request)
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(payload, {"ok": True, "file": rel, "created": False,
                                   "results": [self.gone("p_1"), self.gone("p_2")]})
        self.assertEqual(os.listdir(self.vault), [".obsidian"], "no note, no folder and no image was made")
        # with a bad block beside them: reported, and still nothing is written
        status, _, payload, _ = self.post_notes(dict(request, blocks=request["blocks"] + [
            {"blockId": "p_3", "markdown": "no markers"}]))
        self.assertEqual(status, 200, payload)
        self.assertEqual([r.get("notFound", False) for r in payload["results"]], [True, True, False])
        self.assertEqual(payload["results"][2]["error"], "markdown must be one block between its marginalia markers")
        self.assertEqual(os.listdir(self.vault), [".obsidian"])
        # the note's folder there, the note not: no note is made; an empty note is not rewritten
        self.write_note_file("Notes/Marginalia/Other.md", "# Other\n")
        both = [self.gone("p_1"), self.gone("p_2")]
        status, _, payload, _ = self.post_notes(request)
        self.assertEqual((status, payload["created"], payload["results"]), (200, False, both))
        self.assertEqual(os.listdir(os.path.join(self.vault, "Notes", "Marginalia")), ["Other.md"])
        self.write_note_file(rel, "")
        state = self.note_state(rel)
        status, _, payload, _ = self.post_notes(request)
        self.assertEqual((status, payload["created"], payload["results"]), (200, False, both))
        self.assertEqual(self.note_state(rel), state)
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Attachments")), "no image was written")
        # a card never sent beside them makes the note: the edited ones are still left out, p_1's image too
        os.remove(os.path.join(self.vault, *rel.split("/")))
        status, _, payload, _ = self.post_notes(dict(request, blocks=request["blocks"] + [
            {"blockId": "p_3", "markdown": linked("p_3", "three")}]))
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["results"], both + [{"blockId": "p_3", "ok": True, "replaced": False}])
        self.assertIs(payload["created"], True)
        self.assertEqual(self.read(rel), "# Book One\n\n" + linked("p_3", "three") + "\n")
        self.assertFalse(os.path.exists(os.path.join(self.vault, "Attachments")), "no image of a card left out")

    def test_send_all_mixes_new_edited_and_gone_cards(self):
        rel = "Notes/Marginalia/Book One.md"
        date2 = "[Open in Marginalia](http://127.0.0.1:8765/#reader/b1/p_2) · 2026-11-06"
        before = ("# Book One\n\nMine.\n\n" + linked("p_1", "one") + "\n\n" +
                  linked("p_2", "two").replace(date2, date2 + " (checked)") + "\n\n" + linked("p_4", "four") + "\n")
        self.write_note_file(rel, before)
        self.write_note_file("Copy.md", before)
        b64 = base64.b64encode(PNG).decode("ascii")
        blocks = [
            {"blockId": "p_3", "markdown": linked("p_3", "a new card")},              # never sent: added
            self.edited("p_1", linked("p_1", "ONE")),                               # edited: updated in place
            self.edited("p_2", linked("p_2", "TWO")),                               # edited, its copy edited by hand
            {"blockId": "p_5", "markdown": "no markers", "replaceOnly": True},      # a bad block: reported
            {"blockId": "p_6", "markdown": linked("p_6", "![[marginalia-a_1.png]]"), "replaceOnly": False},
            self.edited("p_4", linked("p_4", "FOUR")),
        ]
        images = [{"name": "marginalia-a_1.png", "data": b64}]
        status, _, payload, _ = self.post_notes(self.notes(blocks, images=images))
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload, {"ok": True, "file": rel, "created": False, "results": [
            {"blockId": "p_3", "ok": True, "replaced": False},
            {"blockId": "p_1", "ok": True, "replaced": True},
            self.gone("p_2"),
            {"blockId": "p_5", "ok": False, "error": "markdown must be one block between its marginalia markers"},
            {"blockId": "p_6", "ok": True, "replaced": False},
            {"blockId": "p_4", "ok": True, "replaced": True}]})
        for b in blocks:                                    # what single sends of the cards that went leave
            if b["blockId"] in ("p_3", "p_1", "p_6", "p_4"):
                status, _, single, _ = self.post(self.note(b["blockId"], file="Copy.md", markdown=b["markdown"]))
                self.assertEqual(status, 200, single)
        text = self.read(rel)
        self.assertEqual(text, self.read("Copy.md"))
        self.assertEqual([starts_of(text, p) for p in ("p_1", "p_2", "p_3", "p_4", "p_6")], [1, 1, 1, 1, 1])
        self.assertIn(linked("p_2", "two").replace(date2, date2 + " (checked)"), text, "the hand-edited copy is kept")
        with open(os.path.join(self.vault, "Attachments", "marginalia-a_1.png"), "rb") as f:
            self.assertEqual(f.read(), PNG)

    def test_send_all_writes_no_image_of_a_card_left_out(self):
        # FEATURES A8: an edited card whose copy is gone is neither added nor written, and neither are its images,
        # also when another card of the same request goes in (the page sends every card's images with its request).
        # An image that a card that goes in embeds too is written, and so is one no card embeds (images as /note).
        rel = "Notes/Marginalia/Book One.md"
        att = os.path.join(self.vault, "Attachments")
        b64 = base64.b64encode(PNG).decode("ascii")
        start = "# Book One\n\n" + linked("p_1", "one") + "\n"
        gone = self.edited("p_2", linked("p_2", "TWO ![[marginalia-gone_1.png]]"))
        new = {"blockId": "p_3", "markdown": linked("p_3", "three")}
        for label, blocks, names, written in [
            ("its own image", [gone, new], ["marginalia-gone_1.png"], []),
            ("before and after the cards that go in", [new, gone, self.edited("p_1", linked("p_1", "ONE"))],
             ["marginalia-gone_1.png"], []),
            ("one a card that goes in embeds too, and a card updated in place with its own", [
                self.edited("p_2", linked("p_2", "![[marginalia-gone_1.png]]\n![[marginalia-both_1.png]]")),
                {"blockId": "p_3", "markdown": linked("p_3", "three ![[marginalia-both_1.png]]")},
                self.edited("p_1", linked("p_1", "ONE ![[marginalia-one_1.jpg|300]]"))],
             ["marginalia-gone_1.png", "marginalia-both_1.png", "marginalia-one_1.jpg"],
             ["marginalia-both_1.png", "marginalia-one_1.jpg"]),
            ("a name that only ends like it is another image", [
                gone, {"blockId": "p_3", "markdown": linked("p_3", "![[marginalia-x-marginalia-gone_1.png]]")}],
             ["marginalia-gone_1.png", "marginalia-x-marginalia-gone_1.png"], ["marginalia-x-marginalia-gone_1.png"]),
            ("one no card embeds", [gone, new], ["marginalia-gone_1.png", "marginalia-other_1.png"],
             ["marginalia-other_1.png"]),
        ]:
            with self.subTest(label):
                shutil.rmtree(att, ignore_errors=True)
                self.write_note_file(rel, start)
                status, _, payload, _ = self.post_notes(self.notes(blocks, images=[{"name": n, "data": b64}
                                                                                   for n in names]))
                self.assertEqual(status, 200, payload)
                self.assertEqual([r for r in payload["results"] if not r["ok"]], [self.gone("p_2")])
                self.assertIs(payload["created"], False)
                self.assertEqual(sorted(os.listdir(att)) if os.path.exists(att) else None,
                                 sorted(written) if written else None, "no attachment folder without an image")
                text = self.read(rel)
                self.assertEqual(starts_of(text, "p_2"), 0)
                self.assertNotIn("[[marginalia-gone_1.png", text)
                for b in blocks:                            # what single sends of the cards that went leave
                    if b["blockId"] != "p_2":
                        self.assertIn(b["markdown"], text)
        # a missing note: made with the card that goes in, and the left-out card's image is still not written
        os.remove(os.path.join(self.vault, *rel.split("/")))
        shutil.rmtree(att, ignore_errors=True)
        status, _, payload, _ = self.post_notes(self.notes([gone, new], images=[
            {"name": "marginalia-gone_1.png", "data": b64}]))
        self.assertEqual((status, payload["created"], payload["results"]),
                         (200, True, [self.gone("p_2"), {"blockId": "p_3", "ok": True, "replaced": False}]))
        self.assertEqual(self.read(rel), "# Book One\n\n" + linked("p_3", "three") + "\n")
        self.assertFalse(os.path.exists(att))

    def test_a_copy_put_back_while_its_update_is_sent_gets_its_image(self):
        # the images are picked for each read of the note: a sync that puts an edited card's copy back while the send
        # runs makes the server read the note again, the card is then updated in place, and its image goes with it
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        start = "# Book One\n\n" + linked("p_1", "one") + "\n"
        synced = start + "\n" + linked("p_2", "two") + "\n"
        two = linked("p_2", "TWO ![[marginalia-two_1.png]]")

        def put_back(note):
            with open(note, "w", encoding="utf-8") as f:
                f.write(synced)
        self.write_note_file(rel, start)
        b64 = base64.b64encode(PNG).decode("ascii")
        with self.saves_before_the_write(path, 1, put_back) as saves:
            status, _, payload, _ = self.post_notes(self.notes(
                [self.edited("p_2", two), {"blockId": "p_3", "markdown": linked("p_3", "three")}],
                images=[{"name": "marginalia-two_1.png", "data": b64}]))
        self.assertEqual(len(saves), 1)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["results"], [{"blockId": "p_2", "ok": True, "replaced": True},
                                              {"blockId": "p_3", "ok": True, "replaced": False}])
        self.assertEqual(self.read(rel),
                         synced.replace(linked("p_2", "two"), two) + "\n" + linked("p_3", "three") + "\n")
        img = os.path.join(self.vault, "Attachments", "marginalia-two_1.png")
        self.assertTrue(os.path.isfile(img), "the image the note now embeds is written")
        with open(img, "rb") as f:
            self.assertEqual(f.read(), PNG)

    def test_send_all_replace_only_must_be_true_or_false(self):
        rel = "Notes/Marginalia/Book One.md"
        before = "# Book One\n\n" + linked("p_1", "one") + "\n"
        self.write_note_file(rel, before)
        for value in ("yes", "true", 1, 0, None, [], {}):
            with self.subTest(value=value):
                status, _, payload, _ = self.post_notes(self.notes([
                    {"blockId": "p_2", "markdown": linked("p_2", "two"), "replaceOnly": value}]))
                why = "replaceOnly must be true or false"
                self.assertEqual(status, 400, payload)
                self.assertEqual(payload, {"ok": False, "error": "no block could be written: " + why,
                                           "results": [{"blockId": "p_2", "ok": False, "error": why}]})
                self.assertEqual(self.read(rel), before, "never read as a block to add")
        status, _, payload, _ = self.post_notes(self.notes([
            {"blockId": "p_2", "markdown": linked("p_2", "two"), "replaceOnly": 1},
            {"blockId": "p_3", "markdown": linked("p_3", "three"), "replaceOnly": False}]))
        self.assertEqual(status, 200, payload)
        self.assertEqual([(r["blockId"], r["ok"]) for r in payload["results"]], [("p_2", False), ("p_3", True)])
        self.assertEqual(self.read(rel), before + "\n" + linked("p_3", "three") + "\n")

    def test_the_single_endpoint_never_reads_replace_only(self):
        # POST /api/obsidian/note is unchanged: it adds a block it does not find, with or without the field
        before = "# Book One\n\n" + linked("p_1", "one") + "\n"
        for name, extra in [("Plain.md", {}), ("Flagged.md", {"replaceOnly": True}), ("Odd.md", {"replaceOnly": "x"})]:
            with self.subTest(name):
                rel = "Notes/" + name
                self.write_note_file(rel, before)
                status, _, payload, _ = self.post(self.note("p_2", file=rel, markdown=linked("p_2", "two"), **extra))
                self.assertEqual((status, payload),
                                 (200, {"ok": True, "file": rel, "created": False, "replaced": False}))
                self.assertEqual(self.read(rel), before + "\n" + linked("p_2", "two") + "\n")
                status, _, payload, _ = self.post(self.note("p_1", file=rel, markdown=linked("p_1", "ONE"), **extra))
                self.assertEqual((status, payload["replaced"]), (200, True), payload)

    def test_a_copy_deleted_while_its_update_is_sent_is_not_added_again(self):
        # the user deletes a block in Obsidian while a send-all runs: the server sees the save, reads the note again,
        # and the edited card is left out, not added; the user's deletion is kept
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        start = "# Book One\n\n" + linked("p_1", "one") + "\n\n" + linked("p_2", "two") + "\n"
        saved = "# Book One\n\n" + linked("p_2", "two") + "\n"

        def delete_p_1(note):
            with open(note, "w", encoding="utf-8") as f:
                f.write(saved)
        for blocks, results in [
            ([self.edited("p_1", linked("p_1", "ONE"))], [self.gone("p_1")]),
            ([self.edited("p_1", linked("p_1", "ONE")), {"blockId": "p_3", "markdown": linked("p_3", "three")},
              self.edited("p_2", linked("p_2", "TWO"))],
             [self.gone("p_1"), {"blockId": "p_3", "ok": True, "replaced": False},
              {"blockId": "p_2", "ok": True, "replaced": True}]),
        ]:
            with self.subTest(len(blocks)):
                self.write_note_file(rel, start)
                with self.saves_before_the_write(path, 1, delete_p_1) as saves:
                    status, _, payload, _ = self.post_notes(self.notes(blocks))
                self.assertEqual(len(saves), 1)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["results"], results)
                items = [(b["markdown"], b["blockId"], b.get("replaceOnly", False)) for b in blocks]
                self.assertEqual(self.read(rel), one_by_one(saved, items)[0], "the deletion is kept")
                self.assertEqual(starts_of(self.read(rel), "p_1"), 0)
                self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ["Book One.md"], "no temp file is left")

    def test_send_all_replace_only_never_adds_a_copy_to_hand_edited_notes(self):
        # property, through the real endpoint: random notes a person edited by hand (PureHelpersTest's generator) and
        # random requests of new cards and edited ones. The note ends exactly as single sends of the cards that went
        # would leave it; an edited card never adds a block of its id; when none went, the note is not written (and
        # a missing one is not made)
        gen = PureHelpersTest()
        rnd = random.Random(20261109)
        rel = "Notes/Marginalia/Book One.md"
        path = os.path.join(self.vault, *rel.split("/"))
        seen = {None: 0, True: 0, False: 0, "nothing written": 0}
        for _ in range(150):
            if os.path.exists(path):
                os.remove(path)
            note = gen.random_note(rnd) if rnd.random() < 0.9 else None
            if note is not None:
                self.write_note_file(rel, "")
                with open(path, "wb") as f:
                    f.write(note.encode("utf-8"))
                state = self.note_state(rel)
            items = [(gen.valid_block(rnd, pid, rnd.random() < 0.8), pid, rnd.random() < 0.6)
                     for pid in rnd.sample(gen.IDS, rnd.randint(1, len(gen.IDS)))]
            blocks = [dict({"blockId": pid, "markdown": md}, **({"replaceOnly": True} if only else
                                                               {"replaceOnly": False} if rnd.random() < 0.5 else {}))
                      for md, pid, only in items]
            status, _, payload, _ = self.post_notes(self.notes(blocks))
            self.assertEqual(status, 200, payload)
            expected, flags = one_by_one("# Book One\n\n" if note is None else note, items)
            self.assertEqual(payload["results"], [self.gone(pid) if f is None else
                                                  {"blockId": pid, "ok": True, "replaced": f}
                                                  for (_, pid, _), f in zip(items, flags)], repr(note))
            for f in flags:
                seen[f] += 1
            if all(f is None for f in flags):
                seen["nothing written"] += 1
                self.assertIs(payload["created"], False)
                if note is None:
                    self.assertFalse(os.path.exists(path), "no note was made")
                else:
                    self.assertEqual(self.note_state(rel), state, "the note was not written")
                continue
            self.assertIs(payload["created"], note is None)
            with open(path, "rb") as f:
                text = f.read().decode("utf-8")
            self.assertEqual(text, expected, repr(note))
            for md, pid, only in items:
                if only:
                    self.assertEqual(starts_of(text, pid), starts_of(note or "", pid), (note, pid))
        self.assertTrue(all(n >= 10 for n in seen.values()), seen)


class PureHelpersTest(unittest.TestCase):
    def test_find_block_needs_its_own_end_marker(self):
        a, b = block("p_1", "x"), block("p_2", "y")
        text = "# T\n\n" + a + "\n\n" + b + "\n"
        span = serve.find_block(text, "p_1")
        self.assertEqual(text[span[0]:span[1]], a)
        broken = text.replace(a, a.replace("\n<!-- /marginalia -->", ""))
        self.assertIsNone(serve.find_block(broken, "p_1"))
        self.assertEqual(broken[slice(*serve.find_block(broken, "p_2"))], b)

    def test_find_block_takes_only_a_span_that_is_one_block(self):
        a, b = block("p_A", "alpha"), block("p_B", "beta")
        ok = "# T\n\n" + a + "\n\n" + b + "\n"
        self.assertEqual(ok[slice(*serve.find_block(ok, "p_A"))], a)
        # A's end and B's start deleted: the span from A's start to B's end holds two date lines
        swallow = ok.replace("\n<!-- /marginalia -->\n\n<!-- marginalia:p_B -->\n", "\n\n")
        self.assertIsNone(serve.find_block(swallow, "p_A"))
        # a body line that reads as a date line makes the span ambiguous too (the app escapes it: 2026\-01-01)
        self.assertIsNone(serve.find_block(block("p_A", "2026-01-01"), "p_A"))
        self.assertIsNotNone(serve.find_block(block("p_A", "2026\\-01-01"), "p_A"))
        # ASCII digits only, like the client's \d: other digits are text the client leaves alone
        self.assertIsNotNone(serve.find_block(block("p_A", "٢٠٢٦-١١-٠٦"), "p_A"))
        # the date line must be the line right before the end marker
        self.assertIsNone(serve.find_block(block("p_A", "x").replace("2026-11-06\n", "2026-11-06\nmine\n"), "p_A"))
        # a later complete copy is found when the first one is broken (a re-send after a hand edit appended it)
        broken = "# T\n\n" + a.replace("\n<!-- /marginalia -->", "") + "\n\n" + b + "\n\n" + block("p_A", "again") + "\n"
        span = serve.find_block(broken, "p_A")
        self.assertEqual(broken[span[0]:span[1]], block("p_A", "again"))

    def test_the_date_line_must_be_the_blocks_own(self):
        own = "[Open in Marginalia](http://127.0.0.1:8765/#reader/b1/p_A) · 2026-11-06"
        self.assertEqual(serve.date_kind(own, "p_A"), "own")
        self.assertEqual(serve.date_kind(own + " \t", "p_A"), "own")
        self.assertEqual(serve.date_kind("[Open in Marginalia](http://localhost:9000/#reader//p_A) · 2026-11-06", "p_A"), "own")
        self.assertEqual(serve.date_kind("2026-11-06", "p_A"), "date")
        self.assertEqual(serve.date_kind(own, "p_B"), "other")
        self.assertEqual(serve.date_kind(own.replace("p_A", "p_AB"), "p_A"), "other")
        self.assertEqual(serve.date_kind("[Open in Marginalia](x) · 2026-11-06", "p_A"), "other")
        self.assertIsNone(serve.date_kind(own + " #seen", "p_A"))
        a, b = linked("p_A", "alpha"), linked("p_B", "beta")
        two = "# T\n\n" + a + "\n\n" + b + "\n"
        self.assertEqual(two[slice(*serve.find_block(two, "p_A", linked=True))], a)
        self.assertIsNone(serve.find_block(two, "p_A"), "a date-alone send never claims a linked block")
        merged = two.replace(a.split("\n")[-2] + "\n<!-- /marginalia -->\n\n<!-- marginalia:p_B -->\n", "")
        self.assertIsNone(serve.find_block(merged, "p_A", linked=True), "B's date line is not A's")
        self.assertIsNone(serve.find_block(block("p_A", "x"), "p_A", linked=True), "a date alone is not A's link")
        # an edited copy of A's own link line anywhere in the span (fenced or not) makes it two blocks' worth
        for extra in [a.split("\n")[-2] + " #seen", "  " + a.split("\n")[-2], "```\n" + a.split("\n")[-2] + "\n```"]:
            with self.subTest(extra=extra):
                self.assertIsNone(serve.find_block(linked("p_A", "body\n" + extra), "p_A", linked=True))
        # links to other blocks and escaped dates in the body are the user's text
        body = "[Open in Marginalia](http://127.0.0.1:8765/#reader/b1/p_X) · 2026-11-05 see\n" + a.split("\n")[-2].replace("2026-", "2026\\-")
        self.assertIsNotNone(serve.find_block(linked("p_A", body), "p_A", linked=True))

    def test_check_block_accepts_only_a_block_the_next_send_can_claim(self):
        self.assertTrue(serve.check_block(linked("p_A", "x"), "p_A"))
        self.assertTrue(serve.check_block(block("p_A", "x"), "p_A"))
        for label, md in [
            ("a link to another block", linked("p_B", "x").replace("p_B -->", "p_A -->")),
            ("a link without its route", block("p_A", "x").replace("\n2026-11-06\n", "\n[Open in Marginalia](x) · 2026-11-06\n")),
            ("its own link twice", linked("p_A", linked("p_A", "x").split("\n")[-2] + " again")),
            ("its own link in a date-alone block", block("p_A", linked("p_A", "x").split("\n")[-2] + " again")),
        ]:
            with self.subTest(label):
                with self.assertRaises(serve.ApiError) as cm:
                    serve.check_block(md, "p_A")
                self.assertEqual(cm.exception.status, 400)

    def test_fenced_relaxed_reads_a_fence_without_a_closer_as_text(self):
        lines = ["intro", "```", "<!-- marginalia:p_A -->", "~~~", "code", "~~~", "after"]
        self.assertEqual(serve.fenced(lines), [False, True, True, True, True, True, True], "strict: open to the end")
        self.assertEqual(serve.fenced(lines, relaxed=True), [False, False, False, True, True, True, False])
        closed = ["```", "x", "```", "y"]
        self.assertEqual(serve.fenced(closed), serve.fenced(closed, relaxed=True))
        shorter = ["````", "```", "x", "```"]                   # a shorter fence never closes a longer one
        self.assertEqual(serve.fenced(shorter), [True, True, True, True])
        self.assertEqual(serve.fenced(shorter, relaxed=True), [False, True, True, True])
        # linear time: many openers without a closer (the strict reading is the same at every length)
        t = time.perf_counter()
        self.assertFalse(any(serve.fenced(["```x"] * 100000, relaxed=True)))
        self.assertLess(time.perf_counter() - t, 2.0)

    def test_marker_checks_take_linear_time_on_long_runs_of_spaces(self):
        # '<!--' and a long run of whitespace used to cost seconds (quadratic backtracking), holding up the whole server
        line = "my edit <!--" + " \t" * 50000 + "x"
        md = linked("p_A", line)
        t = time.perf_counter()
        self.assertEqual(serve.check_block(md, "p_A"), md)
        self.assertIsNotNone(serve.find_block("# T\n\n" + md + "\n", "p_A", linked=True))
        self.assertIsNone(serve.LOOSE_MARKER_RE.search(line))
        self.assertLess(time.perf_counter() - t, 1.0)
        for text in ["<!-- marginalia:p", "<!--/marginalia", "<!-- / MARGINALIA", "<!--\t/\tmarginalia", "<!--  marginalia"]:
            self.assertTrue(serve.LOOSE_MARKER_RE.search("x " + text), text)
        for text in ["<!-- x marginalia", "<!-- // marginalia", "<!- marginalia", "<!-- marginalia"]:
            self.assertIsNone(serve.LOOSE_MARKER_RE.search(text), text)

    def test_client_is_loopback(self):
        for addr in ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1", ("127.0.0.1", 5), ("::1", 5, 0, 0)]:
            self.assertTrue(serve.client_is_loopback(addr), addr)
        for addr in ["192.168.1.2", "10.0.0.1", "0.0.0.0", "fe80::1%en0", "::ffff:10.0.0.1", "", None, "localhost", "x"]:
            self.assertFalse(serve.client_is_loopback(addr), addr)

    def test_attachment_dir_rules(self):
        root, note = "/v", "/v/Notes/Book.md"
        self.assertEqual(serve.attachment_dir(root, note, "/"), "/v")
        self.assertEqual(serve.attachment_dir(root, note, ""), "/v")
        self.assertEqual(serve.attachment_dir(root, note, "../up"), "/v")

    # ---- send all: upsert_blocks and find_span must answer exactly as upsert_text and find_block

    IDS = ["p_1", "p_2", "p_3", "p_A", "x"]
    FENCES = ["```", "````", "~~~", "~~~~", "```py", "``` x`y", "   ```", "    ```", "```\r", "~~~ \t", "`` `", "```` "]

    @staticmethod
    def link_line(pid, collection="b1"):
        return "[Open in Marginalia](http://127.0.0.1:8765/#reader/%s/%s) · 2026-11-06" % (collection, pid)

    def junk_lines(self, rnd):
        """Lines a hand edit could leave in a note: fences of every kind, dates, links, marker-like lines, text."""
        out = []
        for _ in range(rnd.randint(0, 4)):
            r = rnd.random()
            if r < 0.15:
                out.append(rnd.choice(self.FENCES))
            elif r < 0.22:
                out.append("2026-01-01")
            elif r < 0.27:
                out.append(self.link_line(rnd.choice(self.IDS)))
            elif r < 0.30:
                out.append(self.link_line(rnd.choice(self.IDS)) + " #seen")
            elif r < 0.34:
                out.append("<!-- marginalia:" + rnd.choice(self.IDS) + " -->")
            elif r < 0.37:
                out.append("<!-- /marginalia -->")
            elif r < 0.40:
                out.append(" <!--/marginalia-->")
            elif r < 0.46:
                out.append(rnd.choice(["", "2026\\-01-01"]))
            else:
                out.append(rnd.choice(["text", "Q. q", "A. a", "> quote", "### p. 1", "x\ry", "  ", "\t"]))
        return out

    def random_note(self, rnd):
        lines = ["# Title"] if rnd.random() < 0.5 else []
        for _ in range(rnd.randint(0, 6)):
            if rnd.random() < 0.55:                       # a block, now and then hand-edited
                pid = rnd.choice(self.IDS)
                lines.append("<!-- marginalia:%s -->" % pid + rnd.choice(["", "", " ", "\t"]))
                lines += self.junk_lines(rnd)
                lines.append(self.link_line(pid, rnd.choice(["b1", "d9", ""])) if rnd.random() < 0.6 else "2026-11-06")
                if rnd.random() < 0.9:
                    lines.append("<!-- /marginalia -->" + rnd.choice(["", "", " "]))
            else:
                lines += self.junk_lines(rnd)
            if rnd.random() < 0.5:
                lines.append("")
        ending = rnd.choice(["\n", "\n", "\r\n", "mixed"])
        if ending == "mixed":
            text = "".join(line + rnd.choice(["\n", "\r\n"]) for line in lines)
        else:
            text = ending.join(lines) + (ending if rnd.random() < 0.7 else "")
        if rnd.random() < 0.1:
            text = "\ufeff" + text
        if rnd.random() < 0.1:
            text += "\r"
        return "" if rnd.random() < 0.03 else text

    def valid_block(self, rnd, pid, link=True):
        """A block check_block() accepts, as the app sends them: closed fences (a date line inside one), escaped dates."""
        body = []
        for _ in range(rnd.randint(0, 3)):
            if rnd.random() < 0.35:
                fence = rnd.choice(["```", "~~~", "````", "~~~~~"])
                close = rnd.choice([fence, fence + fence[0], fence + " "])
                body += [fence + rnd.choice(["", "py", " x"]), "code", rnd.choice(["2026-01-01", "<x>"]), close]
            else:
                body.append(rnd.choice(["text", "2026\\-01-01", "Q. q", "", "x\ry"]))
        md = "\n".join(["<!-- marginalia:%s -->" % pid, "### p. 1"] + body +
                       ["", self.link_line(pid) if link else "2026-11-06", "<!-- /marginalia -->"])
        return serve.check_block(md, pid)

    def assert_same_as_one_by_one(self, note, items):
        expected, flags = one_by_one(note, items)
        self.assertEqual(serve.upsert_blocks(note, items), (expected, flags), repr(note))
        return flags

    @contextlib.contextmanager
    def checked_index(self):
        """upsert_blocks compares its FenceIndex and "\\r\\n" count with fresh ones after every block."""
        serve._check_index = True
        try:
            yield
        finally:
            serve._check_index = False

    def test_find_span_answers_as_find_block_on_hand_edited_notes(self):
        rnd = random.Random(20261109)
        for _ in range(1500):
            note = self.random_note(rnd)
            index = serve.FenceIndex.of(note)
            flags = serve.fenced([r[2] for r in self.rows_without_bom(note)], relaxed=True)
            starts = [r[0] for r in serve.note_lines(note)]
            self.assertEqual([serve.FenceIndex.of(note).fenced(s) for s in starts], flags, repr(note))
            places = {}                                   # as upsert_blocks finds the start lines: all in one pass
            for m in serve.START_ANY_RE.finditer(note):
                places.setdefault(m.group(1), []).append(m.start())
            for pid in self.IDS:
                for link in (False, True):
                    expected = serve.find_block(note, pid, link)
                    self.assertEqual(serve.find_span(note, pid, link, lambda: index), expected, (note, pid, link))
                    self.assertEqual(serve.find_span(note, pid, link, lambda: index, places.get(pid, ())), expected,
                                     (note, pid, link))

    @staticmethod
    def rows_without_bom(note):
        rows = serve.note_lines(note)
        if rows[0][2].startswith("\ufeff"):
            rows[0] = (rows[0][0] + 1, rows[0][1], rows[0][2][1:])
        return rows

    def test_send_all_upserts_exactly_as_one_send_after_another(self):
        rnd = random.Random(1109)
        replaced = 0
        with self.checked_index():
            for _ in range(1200):                         # notes a person edited by hand
                note = self.random_note(rnd)
                items = [(self.valid_block(rnd, pid, rnd.random() < 0.7), pid)
                         for pid in rnd.sample(self.IDS, rnd.randint(1, len(self.IDS)))]
                replaced += sum(self.assert_same_as_one_by_one(note, items))
            ids = ["p_%d" % i for i in range(8)]
            junk = ["```", "~~~", "````", "```py", "~~~ x", "``` a`b", "text", "", "- item", "  ```", "2026-01-01"]
            for _ in range(1200):                         # notes of sent blocks with stray fences between them
                parts = ["# T\n\n"] if rnd.random() < 0.5 else []
                for pid in rnd.sample(ids, rnd.randint(0, len(ids))):
                    if rnd.random() < 0.4:
                        parts.append("\n".join(rnd.choice(junk) for _ in range(rnd.randint(1, 3))) + "\n")
                    parts.append(self.valid_block(rnd, pid, rnd.random() < 0.8) + "\n\n")
                note = "".join(parts)
                if rnd.random() < 0.3:
                    note = note.replace("\n", "\r\n")
                if rnd.random() < 0.1:
                    note = note.rstrip("\r\n") + rnd.choice(["", "\r"])
                if rnd.random() < 0.1:
                    note = "\ufeff" + note
                items = [(self.valid_block(rnd, pid, rnd.random() < 0.8), pid)
                         for pid in rnd.sample(ids, rnd.randint(1, len(ids)))]
                replaced += sum(self.assert_same_as_one_by_one(note, items))
        self.assertGreater(replaced, 1000, "the notes held blocks to replace (about 1500 do)")

    def test_send_all_follows_a_fence_a_new_block_closes(self):
        # A ``` line above the blocks with no closer below it is no fence (Obsidian ends it with its list item). Once
        # an updated block brings fence lines, that ``` pairs with them: the blocks below it read as code, so the next
        # update adds a copy, exactly as two single sends would.
        a, b = linked("p_A", "alpha"), linked("p_B", "beta")
        note = "# T\n\n- setup\n  ```\n\n" + a + "\n\n" + b + "\n"
        items = [(serve.check_block(linked("p_B", "```py\nprint(1)\n```"), "p_B"), "p_B"),
                 (serve.check_block(linked("p_A", "ALPHA"), "p_A"), "p_A")]
        with self.checked_index():
            self.assertEqual(self.assert_same_as_one_by_one(note, items), [True, False])
        # a CRLF note whose last line ends in a lone "\r", a byte order mark, a missing last newline
        for note in ["# T\r\n\r\n" + a.replace("\n", "\r\n") + "\r", "\ufeff" + a + "\n\n" + b,
                     "```\r\n" + a.replace("\n", "\r\n") + "\r\n```\r"]:
            with self.subTest(note=note), self.checked_index():
                self.assert_same_as_one_by_one(note, [(serve.check_block(linked(p, "new"), p), p) for p in ("p_B", "p_A", "p_C")])

    def test_send_all_takes_linear_time(self):
        fenced_body = "Q. what does it print?\nA. two lines\n```py\nprint(1)\n```"
        items = [(serve.check_block(linked("p_%d" % i, fenced_body if i % 2 else "text %d" % i), "p_%d" % i), "p_%d" % i)
                 for i in range(2000)]
        t = time.perf_counter()
        note, flags = serve.upsert_blocks("# Big\n\n", items)
        self.assertEqual(flags, [False] * 2000)
        note2, flags = serve.upsert_blocks(note, [(md.replace("text", "TEXT"), pid) for md, pid in reversed(items)])
        self.assertEqual(flags, [True] * 2000)
        self.assertEqual(note2.count("<!-- marginalia:"), 2000)
        self.assertLess(time.perf_counter() - t, 10.0, "about 1 s here; one upsert_text per block took a minute")

    def test_send_all_takes_linear_time_with_long_blocks_too(self):
        # 2000 blocks of about 5 KB with 𝑥 in them (Python then keeps the note at 4 bytes a character), 10 MB in all:
        # when every block copied the whole note this took about 10 s to add them and as long again to update them
        body = ("Q. " + "the wave function 𝑥 collapses when it is measured " * 100).strip()
        items = [(serve.check_block(linked("p_%d" % i, body + " %d" % i), "p_%d" % i), "p_%d" % i) for i in range(2000)]
        t = time.perf_counter()
        note, added = serve.upsert_blocks("# Big\n\n", items)
        note2, updated = serve.upsert_blocks(note, [(md.replace("Q. ", "Q2. ", 1), pid) for md, pid in reversed(items)])
        elapsed = time.perf_counter() - t
        self.assertEqual((added, updated), ([False] * 2000, [True] * 2000))
        self.assertGreater(len(note2), 10 * 1000 * 1000)
        self.assertEqual(note2.count("\nQ2. "), 2000)
        self.assertEqual(note2, note.replace("\nQ. ", "\nQ2. "))
        self.assertLess(elapsed, 5.0, "about 0.5 s here; copying the note for every block took 20 s")

    def test_send_all_batches_follow_fences_that_change_far_from_a_block(self):
        # "  ```" above the blocks has no closer, so it is no fence; once p_C's new text brings a closing fence, it
        # pairs with it and the blocks between them read as code: p_B, sent after p_C, is then added, not replaced
        # (exactly what single sends do). Here that happens after the first block, inside a batch.
        a, b, c = linked("p_A", "alpha"), linked("p_B", "beta"), linked("p_C", "gamma")
        note = "# T\n\n- setup\n  ```\n\n" + a + "\n\n" + b + "\n\n" + c + "\n"
        items = [(serve.check_block(linked(p, body), p), p) for p, body in
                 [("p_A", "ALPHA"), ("p_C", "```py\nprint(1)\n```"), ("p_B", "BETA"), ("p_D", "delta")]]
        with self.checked_index():
            self.assertEqual(self.assert_same_as_one_by_one(note, items), [True, True, False, False])
        # and the same with the note's line ends turned to CRLF, and with a byte order mark
        for variant in (note.replace("\n", "\r\n"), "﻿" + note):
            with self.subTest(variant=variant[:12]), self.checked_index():
                self.assert_same_as_one_by_one(variant, items)

    def test_send_all_writes_each_block_with_the_line_end_the_note_has_then(self):
        # a block that still holds a "\r\n" once check_block and upsert_text have each turned "\r\n" into "\n" (here
        # "\r\r\r\n" in the request) brings the note its first "\r\n": every block after it is written with "\r\n",
        # as single sends would
        note = "# T\n\n" + linked("p_1", "one") + "\n\n" + linked("p_2", "two") + "\n"
        items = [(serve.check_block(linked("p_1", "ONE"), "p_1"), "p_1"),
                 (serve.check_block(linked("p_3", "a line that ends in CRs\r\r\r\nnext"), "p_3"), "p_3"),
                 (serve.check_block(linked("p_2", "TWO"), "p_2"), "p_2"),
                 (serve.check_block(linked("p_4", "four"), "p_4"), "p_4")]
        with self.checked_index():
            self.assertEqual(self.assert_same_as_one_by_one(note, items), [True, False, True, False])
        text = serve.upsert_blocks(note, items)[0]
        self.assertIn(linked("p_4", "four").replace("\n", "\r\n"), text)
        # two blocks with one id (not from a request: /notes refuses them) still give what single sends give
        twice = items + [(serve.check_block(linked("p_1", "ONE again"), "p_1"), "p_1")]
        with self.checked_index():
            self.assert_same_as_one_by_one(note, twice)

    def test_a_replace_only_block_never_adds_a_block_of_its_id(self):
        # A8 (property): a card sent before and edited since goes with replaceOnly. On notes a person edited by hand
        # (edited or deleted markers and date lines, merged blocks, stray fences, copies in fences, every kind of line
        # end, a byte order mark) and on notes of sent blocks with stray fences between them, upsert_blocks gives
        # exactly what single sends of the blocks that went leave (one_by_one), and a replace_only block never adds a
        # block of its id: the note holds exactly as many as before, so never a second one
        rnd = random.Random(20261108)
        seen = {None: 0, True: 0, False: 0}
        ids = ["p_%d" % i for i in range(8)]
        junk = ["```", "~~~", "````", "```py", "~~~ x", "``` a`b", "text", "", "- item", "  ```", "2026-01-01"]

        def check(note, items):
            expected, flags = one_by_one(note, items)
            text, got = serve.upsert_blocks(note, items)
            self.assertEqual((text, got), (expected, flags), repr(note))
            for (md, pid, only), flag in zip(items, flags):
                seen[flag] += 1
                if only:
                    self.assertIsNot(flag, False, "a replace_only block is never added")
                    self.assertEqual(starts_of(text, pid), starts_of(note, pid), (note, pid))
                else:
                    self.assertIsNotNone(flag)
            if all(f is None for f in flags):
                self.assertEqual(text, note, "nothing went in: the note is as it was")
        with self.checked_index():
            for _ in range(1500):                         # notes a person edited by hand
                note = self.random_note(rnd)
                check(note, [(self.valid_block(rnd, pid, rnd.random() < 0.7), pid, rnd.random() < 0.6)
                             for pid in rnd.sample(self.IDS, rnd.randint(1, len(self.IDS)))])
            for _ in range(800):                          # notes of sent blocks with stray fences between them
                parts = ["# T\n\n"] if rnd.random() < 0.5 else []
                for pid in rnd.sample(ids, rnd.randint(0, len(ids))):
                    if rnd.random() < 0.4:
                        parts.append("\n".join(rnd.choice(junk) for _ in range(rnd.randint(1, 3))) + "\n")
                    parts.append(self.valid_block(rnd, pid, rnd.random() < 0.8) + "\n\n")
                note = "".join(parts)
                if rnd.random() < 0.3:
                    note = note.replace("\n", "\r\n")
                if rnd.random() < 0.1:
                    note = note.rstrip("\r\n") + rnd.choice(["", "\r"])
                if rnd.random() < 0.1:
                    note = "﻿" + note
                check(note, [(self.valid_block(rnd, pid, rnd.random() < 0.8), pid, rnd.random() < 0.7)
                             for pid in rnd.sample(ids, rnd.randint(1, len(ids)))])
        self.assertTrue(all(n > 1000 for n in seen.values()), seen)

    def test_replace_only_blocks_left_out_before_the_first_block_that_goes_in(self):
        # the blocks left out before the first one that goes in are looked up in the note as it is; that first one
        # then goes in as a single send puts it (a note without its last line end, one ending in a lone "\r", a byte
        # order mark, an empty note), and the rest go in batches
        b1, b2, b3 = (serve.check_block(linked(p, "new " + p), p) for p in ("p_1", "p_2", "p_3"))
        old2 = linked("p_2", "old")
        for note in ["", "# T", "# T\r\n\r\nx\r", "﻿# T\n\n" + old2, "# T\n\n" + old2 + "\r",
                     "```\n" + old2 + "\n", "# T\r\n\r\n" + old2.replace("\n", "\r\n") + "\r\n"]:
            for items in ([(b1, "p_1", True), (b3, "p_3", True), (b2, "p_2", False)],
                          [(b1, "p_1", True), (b2, "p_2", True), (b3, "p_3", False)],
                          [(b1, "p_1", True), (b2, "p_2", True), (b3, "p_3", True)],
                          [(b2, "p_2", True)], [(b1, "p_1", True)]):
                with self.subTest(note=note, items=[(p, o) for _, p, o in items]), self.checked_index():
                    flags = self.assert_same_as_one_by_one(note, items)
                    if items[0][1] == "p_1":
                        self.assertIsNone(flags[0], "p_1 is in no note here")
        self.assertEqual(serve.upsert_blocks("", [(b1, "p_1", True)]), ("", [None]))
        self.assertEqual(serve.upsert_blocks("# T", [(b1, "p_1", True), (b2, "p_2", True)]), ("# T", [None, None]))
        self.assertEqual(serve.upsert_blocks("# T", [(b1, "p_1", True), (b3, "p_3", False)]),
                         ("# T\n\n" + b3 + "\n", [None, False]))

    def test_replace_only_takes_linear_time(self):
        # 2000 sent blocks, every odd one's date line edited by hand (its start line is there, but no span can be
        # claimed); the 2000 cards sent back edited, with replaceOnly (the hand-edited ones left out); 2000 edited cards
        # whose blocks are gone, alone and before one that goes in: linear, as the other send-all paths
        items = [(serve.check_block(linked("p_%d" % i, "text %d" % i), "p_%d" % i), "p_%d" % i) for i in range(2000)]
        lines = serve.upsert_blocks("# Big\n\n", items)[0].split("\n")
        for k, line in enumerate(lines):
            if line.startswith("[Open in Marginalia](") and int(line.split("/p_")[1].split(")")[0]) % 2:
                lines[k] = line + " #seen"
        broken = "\n".join(lines)
        edited = [(md.replace("text", "TEXT"), pid, True) for md, pid in reversed(items)]
        gone = [(serve.check_block(linked("q_%d" % i, "x"), "q_%d" % i), "q_%d" % i, True) for i in range(2000)]
        t = time.perf_counter()
        text, flags = serve.upsert_blocks(broken, edited)
        nothing, flags2 = serve.upsert_blocks(broken, gone)
        one, flags3 = serve.upsert_blocks(broken, gone + [edited[1]])
        elapsed = time.perf_counter() - t
        self.assertEqual(flags, [None if int(pid[2:]) % 2 else True for _, pid, _ in edited])
        self.assertEqual((text.count("<!-- marginalia:"), text.count("\ntext "), text.count("\nTEXT ")),
                         (2000, 1000, 1000))
        self.assertEqual((nothing, flags2), (broken, [None] * 2000))
        self.assertEqual(flags3, [None] * 2000 + [True])
        self.assertEqual(one, broken.replace("\ntext 1998\n", "\nTEXT 1998\n"))
        self.assertLess(elapsed, 5.0, "well under a second here")

class BackupApiTest(unittest.TestCase):
    """GET and POST /api/backup on the real handler in a thread, with a throwaway backup folder in a fresh temp folder
    (and a throwaway Obsidian list that names no vault). serve.today() is replaced, so "today" is self.day."""

    @classmethod
    def setUpClass(cls):
        cls.base = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-backup-test-"))
        cls.folder = os.path.join(cls.base, "Marginalia Backups")
        assert os.path.realpath(cls.folder) != os.path.realpath(serve.default_backup_dir())
        cls.httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, backup_dir=cls.folder,
                                      obsidian_config=os.path.join(cls.base, "no-obsidian.json"))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(5)
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.day = "2026-11-09"
        self.saved_today = serve.today
        serve.today = lambda: self.day
        self.outside = os.path.realpath(tempfile.mkdtemp(prefix="outside-", dir=self.base))

    def tearDown(self):
        serve.today = self.saved_today
        if os.path.isdir(self.folder) and not os.path.islink(self.folder):
            os.chmod(self.folder, 0o700)
            shutil.rmtree(self.folder, ignore_errors=True)
        elif os.path.lexists(self.folder):
            os.remove(self.folder)
        shutil.rmtree(self.outside, ignore_errors=True)

    # ---- helpers

    @staticmethod
    def backup_text(tag="one", prompts=2):
        """A JSON backup as M.exporter writes it (JSON.stringify(backup, null, 2): raw UTF-8, escaped lone surrogates)."""
        backup = {"format": "marginalia", "version": 1, "schedulerVersion": 1, "exportedAt": 1762650000000,
                  "scope": "all", "settings": {"reviewKeys": {"showAnswer": "Space"}, "obsidianFolder": "Notes/Marginalia"},
                  "collections": [{"id": "b1", "kind": "book", "name": "Griffiths " + tag}],
                  "prompts": [{"id": "p_%d" % i, "collectionId": "b1", "text": "Q. ψ(x) %s %d\nA. ∫ 𝑥 dx" % (tag, i),
                               "log": [{"at": 1762650000000, "grade": "remembered"}]} for i in range(prompts)],
                  "attachments": []}
        return json.dumps(backup, indent=2, ensure_ascii=False)

    def request(self, method, path, body=None, headers=None):
        return http_request(self.port, method, path, body, headers)

    def post_backup(self, mode, text, headers=None, body=None):
        """POST /api/backup as js/backup.js builds the body: '{"mode":"<mode>","backup":' + the exporter's text + '}'."""
        h = post_headers(self.port)
        h.update(headers or {})
        data = body if body is not None else ('{"mode":"%s","backup":' % mode + text + "}").encode("utf-8")
        return self.request("POST", "/api/backup", data, h)

    def name(self, day=None):
        return "marginalia-backup-%s.json" % (day or self.day)

    def read_backup(self, day=None):
        with open(os.path.join(self.folder, self.name(day)), "rb") as f:
            return f.read().decode("utf-8")

    def put(self, name, data=b"{}"):
        os.makedirs(self.folder, exist_ok=True)
        with open(os.path.join(self.folder, name), "wb") as f:
            f.write(data)

    def listing(self):
        status, headers, payload, _ = self.request("GET", "/api/backup")
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        return payload

    # ---- GET

    def test_nothing_is_listed_or_made_before_the_first_backup(self):
        self.assertEqual(self.listing(), {"ok": True, "dir": serve.display_path(self.folder), "today": "2026-11-09",
                                          "files": []})
        self.assertFalse(os.path.exists(self.folder), "a GET makes no folder")
        os.makedirs(self.folder)
        self.assertEqual(self.listing()["files"], [])

    def test_the_folder_is_shown_with_a_tilde_for_the_home_folder(self):
        home = os.path.expanduser("~")
        self.assertEqual(serve.display_path(os.path.join(home, "Documents", "Marginalia Backups")),
                         "~" + os.sep + os.path.join("Documents", "Marginalia Backups"))
        self.assertEqual(serve.display_path(home), "~")
        self.assertEqual(serve.display_path(home + "x" + os.sep + "y"), home + "x" + os.sep + "y")
        self.assertEqual(serve.display_path("/Volumes/Disk/Backups/"), "/Volumes/Disk/Backups")
        before, day, after = time.strftime("%Y-%m-%d"), self.saved_today(), time.strftime("%Y-%m-%d")
        self.assertRegex(day, r"^\d{4}-\d{2}-\d{2}$")
        self.assertIn(day, {before, after}, "the server's local date")

    # ---- POST

    def test_auto_writes_todays_backup_once_and_manual_replaces_it(self):
        one, two = self.backup_text("one"), self.backup_text("two", prompts=3)
        status, headers, payload, _ = self.post_backup("auto", one)
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(payload, {"ok": True, "file": self.name(), "bytes": len(one.encode("utf-8")), "skipped": False,
                                   "pruned": []})
        self.assertEqual(self.read_backup(), one)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.folder, self.name())).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.folder).st_mode) & 0o077, 0, "the folder is the user's alone")
        # auto again the same day: today's file is kept as it is
        status, _, payload, _ = self.post_backup("auto", two)
        self.assertEqual((status, payload), (200, {"ok": True, "file": self.name(), "bytes": len(one.encode("utf-8")),
                                                   "skipped": True, "pruned": []}))
        self.assertEqual(self.read_backup(), one)
        self.assertEqual(self.listing()["files"], [{"name": self.name(), "date": self.day, "bytes": len(one.encode("utf-8"))}])
        # manual replaces it
        status, _, payload, _ = self.post_backup("manual", two)
        self.assertEqual((status, payload["skipped"], payload["bytes"]), (200, False, len(two.encode("utf-8"))), payload)
        self.assertEqual(self.read_backup(), two)
        # a new day: a new file; the old one stays
        self.day = "2026-11-10"
        status, _, payload, _ = self.post_backup("auto", one)
        self.assertEqual((status, payload["file"], payload["skipped"]), (200, self.name(), False), payload)
        self.assertEqual([f["name"] for f in self.listing()["files"]], [self.name(), self.name("2026-11-09")])
        self.assertEqual(sorted(os.listdir(self.folder)), [self.name("2026-11-09"), self.name()], "no temp file is left")

    def test_the_file_is_the_backups_own_text(self):
        # what Export saves: non-ASCII as is, a lone surrogate escaped, U+2028, control characters escaped
        backup = json.loads(self.backup_text())
        backup["prompts"][0]["text"] = "a lone \ud835 surrogate, a line\u2028separator, a tab\t and 𝑥"
        # JSON.stringify escapes a lone surrogate as \ud835 (Python's json.dumps would leave it raw)
        text = json.dumps(backup, indent=2, ensure_ascii=False).encode("utf-8", "backslashreplace").decode("utf-8")
        self.assertIn("\\ud835", text)
        self.assertIn("\u2028", text)
        status, _, payload, _ = self.post_backup("auto", text)
        self.assertEqual(status, 200, payload)
        with open(os.path.join(self.folder, self.name()), "rb") as f:
            raw = f.read()
        self.assertEqual(raw, text.encode("utf-8"))
        self.assertEqual(json.loads(raw.decode("utf-8")), backup, "the same records come back")
        # any order, spacing and a key given twice (the last one counts, as JSON.parse reads it)
        other = self.backup_text("other")
        body = (' \n{ "backup" : ' + self.backup_text("first") + ' ,\n"backup":' + other + ', "mode" : "manual" }\n')
        status, _, payload, _ = self.post_backup(None, None, body=body.encode("utf-8"))
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.read_backup(), other)
        # a compact backup is kept compact
        compact = json.dumps(json.loads(other), separators=(",", ":"), ensure_ascii=False)
        status, _, payload, _ = self.post_backup("manual", compact)
        self.assertEqual((status, self.read_backup()), (200, compact), payload)

    def test_the_30_newest_are_kept_and_nothing_else_is_touched(self):
        days = ["2026-09-%02d" % d for d in (28, 29, 30)] + ["2026-10-%02d" % d for d in range(1, 32)]
        for d in days:
            self.put(self.name(d), d.encode("ascii"))
        target = os.path.join(self.outside, "target.json")
        with open(target, "w", encoding="utf-8") as f:
            f.write("my file")
        decoys = {
            "marginalia-backup-2026-01-01.json.bak": b"1", "Marginalia-Backup-2026-01-02.json": b"2",
            "marginalia-backup-2026-1-3.json": b"3", "marginalia-backup-2026-01-04.JSON": b"4",
            "marginalia-backup-\u0662\u0660\u0662\u0666-\u0660\u0661-\u0660\u0665.json": b"5",
            "marginalia-backup-2026-01-06.json ": b"6", "my-marginalia-backup-2026-01-07.json": b"7",
            "notes.txt": b"8", ".marginalia-left.tmp": b"9", "marginalia-backup-2026-01-08.json.tmp": b"10",
        }
        for n, data in decoys.items():
            self.put(n, data)
        os.makedirs(os.path.join(self.folder, "marginalia-backup-2000-01-01.json"))
        os.symlink(target, os.path.join(self.folder, "marginalia-backup-2000-01-02.json"))
        status, _, payload, _ = self.post_backup("auto", self.backup_text())
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["pruned"], [self.name(d) for d in days[:5]], "the 5 oldest of 35")
        kept = sorted(n for n in os.listdir(self.folder) if serve.BACKUP_NAME_RE.fullmatch(n))
        self.assertEqual(kept, sorted(["marginalia-backup-2000-01-01.json", "marginalia-backup-2000-01-02.json"] +
                                      [self.name(d) for d in days[5:]] + [self.name()]))
        for n, data in decoys.items():
            with open(os.path.join(self.folder, n), "rb") as f:
                self.assertEqual(f.read(), data, n)
        self.assertTrue(os.path.isdir(os.path.join(self.folder, "marginalia-backup-2000-01-01.json")), "a folder")
        self.assertTrue(os.path.islink(os.path.join(self.folder, "marginalia-backup-2000-01-02.json")), "a symlink")
        with open(target, encoding="utf-8") as f:
            self.assertEqual(f.read(), "my file")
        # the listing shows the backups alone, newest first
        files = self.listing()["files"]
        self.assertEqual([f["name"] for f in files], [self.name()] + [self.name(d) for d in reversed(days[5:])])
        self.assertEqual(files[1], {"name": self.name("2026-10-31"), "date": "2026-10-31", "bytes": 10})
        self.assertEqual(len(files), serve.BACKUP_KEEP)

    def test_newer_names_never_push_out_todays_backup(self):
        for d in range(1, 31):                    # a clock that was years ahead once
            self.put(self.name("2099-01-%02d" % d))
        status, _, payload, _ = self.post_backup("auto", self.backup_text())
        self.assertEqual((status, payload["pruned"]), (200, []), payload)
        self.assertTrue(os.path.isfile(os.path.join(self.folder, self.name())))
        self.day = "2026-11-10"
        status, _, payload, _ = self.post_backup("auto", self.backup_text())
        self.assertEqual((status, payload["pruned"]), (200, [self.name("2026-11-09")]), payload)
        self.assertTrue(os.path.isfile(os.path.join(self.folder, self.name())), "the backup just written stays")

    def test_requests_that_are_not_a_backup_write_nothing(self):
        good = json.loads(self.backup_text())
        bodies = {
            "not JSON": b"not json", "not UTF-8": b'{"mode":"auto","backup":"\xff"}', "a list": b"[]",
            "no backup": b'{"mode":"auto"}', "no mode": ('{"backup":' + self.backup_text() + "}").encode("utf-8"),
            "an unknown mode": ('{"mode":"daily","backup":' + self.backup_text() + "}").encode("utf-8"),
            "mode in capitals": ('{"mode":"AUTO","backup":' + self.backup_text() + "}").encode("utf-8"),
            "extra text after it": ('{"mode":"auto","backup":' + self.backup_text() + "} x").encode("utf-8"),
            "a trailing comma": ('{"mode":"auto","backup":' + self.backup_text() + ",}").encode("utf-8"),
            "NaN": ('{"mode":"auto","backup":' + self.backup_text().replace('"version": 1', '"version": 1, "x": NaN')
                    + "}").encode("utf-8"),
            "Infinity": ('{"mode":"auto","backup":' + self.backup_text().replace('"exportedAt": 1762650000000',
                         '"exportedAt": -Infinity') + "}").encode("utf-8"),
            "nested too deep": b'{"mode":"auto","backup":' + b"[" * 100000 + b"]" * 100000 + b"}",
        }
        for label, change in [("another format", {"format": "anki"}), ("no format", {"format": None}),
                              ("a version that is text", {"version": "1"}), ("a version that is true", {"version": True}),
                              ("version 0", {"version": 0}), ("collections not a list", {"collections": {}}),
                              ("no prompts", {"prompts": None}), ("attachments not a list", {"attachments": "x"})]:
            b = dict(good, **change)
            b = {k: v for k, v in b.items() if v is not None}
            bodies[label] = json.dumps({"mode": "auto", "backup": b}).encode("utf-8")
        bodies["a backup that is text"] = json.dumps({"mode": "auto", "backup": self.backup_text()}).encode("utf-8")
        for label, body in bodies.items():
            with self.subTest(label):
                status, _, payload, _ = self.post_backup(None, None, body=body)
                self.assertEqual(status, 400, payload)
                self.assertEqual(payload["ok"], False)
                self.assertTrue(payload["error"])
                self.assertFalse(os.path.exists(self.folder), "nothing was written")

    def test_guards_refuse_before_anything_is_written(self):
        text = self.backup_text()
        for label, headers, status in [("another site", {"Origin": "https://evil.example"}, 403),
                                       ("no X-Marginalia", {"X-Marginalia": ""}, 403),
                                       ("DNS rebinding", {"Host": "rebind.example:%d" % self.port}, 403),
                                       ("a form post", {"Content-Type": "text/plain"}, 415)]:
            with self.subTest(label):
                code, _, payload, _ = self.post_backup("manual", text, headers)
                self.assertEqual(code, status, payload)
        self.assertEqual(self.request("GET", "/api/backup", headers={"Host": "rebind.example"})[0], 403)
        self.assertEqual(oversized(self.port, "/api/backup", serve.MAX_BACKUP_BODY + 1), 413)
        status, payload = via_socket(self.httpd, ("192.168.1.20", 50000), "GET", "/api/backup")
        self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden client"}))
        status, payload = via_socket(self.httpd, ("10.0.0.5", 50000), "POST", "/api/backup",
                                     ('{"mode":"manual","backup":' + text + "}").encode("utf-8"), post_headers(self.port))
        self.assertEqual(status, 403, payload)
        self.assertFalse(os.path.exists(self.folder), "nothing was written")

    def test_todays_name_held_by_a_folder_or_a_symlink_is_left_alone(self):
        os.makedirs(os.path.join(self.folder, self.name()))
        for mode in ("auto", "manual"):
            status, _, payload, _ = self.post_backup(mode, self.backup_text())
            self.assertEqual(status, 409, payload)
        self.assertEqual(os.listdir(os.path.join(self.folder, self.name())), [])
        os.rmdir(os.path.join(self.folder, self.name()))
        target = os.path.join(self.outside, "elsewhere.json")
        with open(target, "w", encoding="utf-8") as f:
            f.write("mine")
        os.symlink(target, os.path.join(self.folder, self.name()))
        for mode in ("auto", "manual"):
            status, _, payload, _ = self.post_backup(mode, self.backup_text())
            self.assertEqual(status, 409, payload)
        self.assertTrue(os.path.islink(os.path.join(self.folder, self.name())))
        with open(target, encoding="utf-8") as f:
            self.assertEqual(f.read(), "mine")
        self.assertEqual(os.listdir(self.folder), [self.name()], "no temp file is left")

    def test_a_file_with_todays_name_in_other_letters_is_left_alone(self):
        # macOS's disks ignore letter case by default: today's name then reaches Marginalia-Backup-<today>.json, a file
        # the listing and the prune never count. "auto" took it for today's backup (and the page posted the whole
        # backup again at every check), "manual" replaced the user's file and the backup kept the other name.
        variant = self.name().replace("marginalia-backup", "Marginalia-Backup")
        self.put(variant, b"my own file")
        if not os.path.lexists(os.path.join(self.folder, self.name())):
            # a disk that tells letter case apart: two names, two files
            status, _, payload, _ = self.post_backup("auto", self.backup_text())
            self.assertEqual((status, payload["skipped"]), (200, False), payload)
            self.assertEqual(sorted(os.listdir(self.folder)), sorted([variant, self.name()]))
            return
        for mode in ("auto", "manual"):
            status, _, payload, _ = self.post_backup(mode, self.backup_text())
            self.assertEqual(status, 409, payload)
            self.assertEqual(payload, {"ok": False, "error": variant + " in the backup folder has today's backup name "
                                       "in other letters, so it is left as it is; nothing was written"})
        self.assertEqual(os.listdir(self.folder), [variant], "its name as it was, and no temp file")
        with open(os.path.join(self.folder, variant), "rb") as f:
            self.assertEqual(f.read(), b"my own file")
        self.assertEqual(self.listing()["files"], [])
        # one that shows up while an automatic backup is being written is left alone too
        os.rename(os.path.join(self.folder, variant), os.path.join(self.outside, "mine.json"))
        saved = os.link

        def racing(src, dst):
            with open(os.path.join(self.folder, variant), "wb") as f:
                f.write(b"made meanwhile")
            return saved(src, dst)
        os.link = racing
        try:
            status, _, payload, _ = self.post_backup("auto", self.backup_text())
        finally:
            os.link = saved
        self.assertEqual(status, 409, payload)
        self.assertEqual(os.listdir(self.folder), [variant])
        with open(os.path.join(self.folder, variant), "rb") as f:
            self.assertEqual(f.read(), b"made meanwhile")
        # once that file has another name, today's backup is made
        os.remove(os.path.join(self.folder, variant))
        status, _, payload, _ = self.post_backup("auto", self.backup_text())
        self.assertEqual((status, payload["skipped"]), (200, False), payload)
        self.assertEqual(os.listdir(self.folder), [self.name()])

    def test_a_failed_write_leaves_no_temp_file(self):
        self.put(self.name(), b"yesterday's text")
        saved = os.replace

        def failing(src, dst):
            if os.path.dirname(dst) == self.folder:
                raise OSError(errno.EIO, "Input/output error")
            return saved(src, dst)
        os.replace = failing
        try:
            status, _, payload, _ = self.post_backup("manual", self.backup_text())
        finally:
            os.replace = saved
        self.assertEqual(status, 500, payload)
        self.assertEqual(payload, {"ok": False, "error": "could not write the backup: Input/output error"})
        self.assertEqual(os.listdir(self.folder), [self.name()], "no temp file is left")
        self.assertEqual(self.read_backup(), "yesterday's text")

    def test_auto_never_replaces_a_file_that_appears_meanwhile_and_works_without_hard_links(self):
        os.makedirs(self.folder)
        saved = os.link
        late = b"written by someone else in between"

        def racing(src, dst):                     # today's file shows up right before the link
            with open(dst, "wb") as f:
                f.write(late)
            return saved(src, dst)
        os.link = racing
        try:
            status, _, payload, _ = self.post_backup("auto", self.backup_text())
        finally:
            os.link = saved
        self.assertEqual((status, payload["skipped"], payload["bytes"]), (200, True, len(late)), payload)
        self.assertEqual(self.read_backup(), late.decode("ascii"))
        self.assertEqual(os.listdir(self.folder), [self.name()], "no temp file is left")
        os.remove(os.path.join(self.folder, self.name()))

        def unsupported(src, dst):                # a disk without hard links (exFAT, some network disks)
            raise OSError(errno.ENOTSUP, "Operation not supported")
        os.link = unsupported
        try:
            status, _, payload, _ = self.post_backup("auto", self.backup_text())
        finally:
            os.link = saved
        self.assertEqual((status, payload["skipped"]), (200, False), payload)
        self.assertEqual(self.read_backup(), self.backup_text())
        self.assertEqual(os.listdir(self.folder), [self.name()], "no temp file is left")

    def test_a_backup_folder_that_is_a_file_or_unreadable_is_an_error(self):
        with open(self.folder, "w", encoding="utf-8") as f:
            f.write("not a folder")
        status, _, payload, _ = self.request("GET", "/api/backup")
        self.assertEqual((status, payload["ok"]), (500, False), payload)
        self.assertIn("could not read the backup folder", payload["error"])
        status, _, payload, _ = self.post_backup("auto", self.backup_text())
        self.assertEqual((status, payload["ok"]), (500, False), payload)
        self.assertIn("is not a folder", payload["error"])
        with open(self.folder, encoding="utf-8") as f:
            self.assertEqual(f.read(), "not a folder")
        os.remove(self.folder)
        os.makedirs(self.folder)
        os.chmod(self.folder, 0)
        try:
            if os.access(self.folder, os.R_OK):
                return                                    # running as root: chmod 0 does not lock it
            status, _, payload, _ = self.request("GET", "/api/backup")
            self.assertEqual((status, payload["ok"]), (500, False), payload)
        finally:
            os.chmod(self.folder, 0o700)

    def test_a_large_backup(self):
        backup = json.loads(self.backup_text())
        backup["attachments"] = [{"id": "a_%d" % i, "mime": "image/png", "width": 1, "height": 1,
                                  "data": base64.b64encode(os.urandom(750000)).decode("ascii")} for i in range(12)]
        text = json.dumps(backup, indent=2)
        self.assertGreater(len(text), 10 * 1024 * 1024)
        status, _, payload, _ = self.post_backup("manual", text)
        self.assertEqual((status, payload["bytes"]), (200, len(text)), payload)
        self.assertEqual(self.read_backup(), text)

    def test_a_server_without_a_backup_folder_has_no_backup_api(self):
        httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, obsidian_config=os.path.join(self.base, "none.json"))
        t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        try:
            port = httpd.server_address[1]
            status, _, payload, _ = http_request(port, "GET", "/api/backup")
            self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}))
            body = ('{"mode":"manual","backup":' + self.backup_text() + "}").encode("utf-8")
            status, _, payload, _ = http_request(port, "POST", "/api/backup", body, post_headers(port))
            self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}))
        finally:
            httpd.shutdown()
            httpd.server_close()
            t.join(5)

    def test_a_backup_folder_inside_the_app_or_not_absolute_is_refused(self):
        os.symlink(os.path.join(APP, "test"), os.path.join(self.outside, "into-the-app"))
        refused = ["", "  ", "Backups", "./Backups", "~/Backups", APP, APP + os.sep, os.path.join(APP, "backups"),
                   os.path.join(APP, "test", "..", "docs", "x"), os.path.join(APP, "..", os.path.basename(APP), "y"),
                   os.path.join(self.outside, "into-the-app", "b")]
        if os.path.exists(APP.upper()):                      # a case-insensitive disk (macOS's default)
            refused.append(os.path.join(APP.upper(), "b"))
        for value in refused:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    serve.make_server(APP, "127.0.0.1", 0, quiet=True, backup_dir=value)
        self.assertFalse(os.path.exists(os.path.join(APP, "backups")))
        self.assertFalse(os.path.exists(os.path.join(APP, "test", "b")))
        self.assertEqual(serve.check_backup_dir(os.path.join(self.outside, "a", "..", "b") + os.sep, APP),
                         os.path.join(self.outside, "b"))
        self.assertFalse(os.path.exists(os.path.join(self.outside, "b")), "nothing is made before the first backup")


def pdf_body(tag="", size=4096):
    """A PDF as far as the server checks one: "%PDF-" first, then bytes no other call gives."""
    return b"%PDF-1.7\n% " + tag.encode("utf-8") + b"\n" + os.urandom(size)


def sha_of(data):
    return hashlib.sha256(data).hexdigest()


# What PdfBackupApiTest.put_pdf writes by default, and the sha12 a saved PDF holding it is named with: the prune hashes a
# PDF before it deletes it and deletes only one that still holds what its name says (repair B9-R2), so a PDF a test
# expects the prune to delete must hold this (or other content named after its own SHA-256).
SAVED_PDF = b"%PDF-1.4\n% a saved PDF\n"
NOON_MS = time.mktime((2026, 11, 9, 12, 0, 0, 0, 0, -1)) * 1000.0   # PdfBackupApiTest's "now": noon, local time
DAY_MS = 24 * 60 * 60 * 1000
SAVED_12 = sha_of(SAVED_PDF)[:12]


class PdfBackupApiTest(unittest.TestCase):
    """FEATURES B9 on the server: GET /api/backup/pdfs, POST /api/backup/pdf, GET /api/backup/pdf/<sha256> and the prune
    of <backup folder>/PDFs after each JSON backup written, on the real handler in a thread with a throwaway backup
    folder in a fresh temp folder (as BackupApiTest: serve.today() is replaced, so "today" is self.day). The server's
    log lines are caught in self.logged; self.notes() are those about PDFs."""

    @classmethod
    def setUpClass(cls):
        cls.base = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-pdf-test-"))
        cls.folder = os.path.join(cls.base, "Marginalia Backups")
        cls.pdfs = os.path.join(cls.folder, serve.PDF_FOLDER)
        assert os.path.realpath(cls.folder) != os.path.realpath(serve.default_backup_dir())
        cls.httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, backup_dir=cls.folder,
                                      obsidian_config=os.path.join(cls.base, "no-obsidian.json"))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(5)
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.day = "2026-11-09"
        self.saved_today = serve.today
        serve.today = lambda: self.day
        self.now = NOON_MS                                    # the clock that dates tombstones (D23): noon of self.day
        self.saved_now = serve.now_ms
        serve.now_ms = lambda: self.now
        self.outside = os.path.realpath(tempfile.mkdtemp(prefix="outside-", dir=self.base))
        self.logged = []
        handler = self.httpd.RequestHandlerClass.func         # make_server's handler class (quiet: no log)
        self.saved_log = handler.__dict__["log_message"]
        handler.log_message = lambda h, fmt, *args: self.logged.append(fmt % args)

    def tearDown(self):
        self.httpd.RequestHandlerClass.func.log_message = self.saved_log
        serve.today = self.saved_today
        serve.now_ms = self.saved_now
        if os.path.isdir(self.folder) and not os.path.islink(self.folder):
            for d, _, _ in os.walk(self.folder):
                if not os.path.islink(d):
                    os.chmod(d, 0o700)
            shutil.rmtree(self.folder, ignore_errors=True)
        elif os.path.lexists(self.folder):
            os.remove(self.folder)
        shutil.rmtree(self.outside, ignore_errors=True)

    # ---- helpers

    def request(self, method, path, body=None, headers=None):
        return http_request(self.port, method, path, body, headers)

    def pdf_headers(self, data, name="Griffiths", headers=None):
        """The headers js/backup.js sends with a PDF; `headers` adds or replaces some (None leaves one out)."""
        h = {"Origin": "http://127.0.0.1:%d" % self.port, "X-Marginalia": "1", "Content-Type": "application/pdf",
             "X-Marginalia-Sha256": sha_of(data), "X-Marginalia-Name": urllib.parse.quote(name)}
        h.update(headers or {})
        return {k: v for k, v in h.items() if v is not None}

    def upload(self, data, name="Griffiths", headers=None):
        """POST /api/backup/pdf -> (status, headers, JSON)."""
        status, h, payload, _ = self.request("POST", serve.PDF_PATH, data, self.pdf_headers(data, name, headers))
        return status, h, payload

    def start_upload(self, data, name, length=None, headers=None, port=None):
        """Open a POST /api/backup/pdf and send its headers alone (conn.send sends the body) -> the connection."""
        port = port or self.port
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        conn.putrequest("POST", serve.PDF_PATH, skip_host=True, skip_accept_encoding=True)
        h = dict(self.pdf_headers(data, name, headers), Host="127.0.0.1:%d" % port)
        h["Origin"] = "http://127.0.0.1:%d" % port
        if length is not False:
            h["Content-Length"] = str(len(data) if length is None else length)
        for k, v in h.items():
            conn.putheader(k, v)
        conn.endheaders()
        return conn

    def listing(self):
        status, headers, payload, _ = self.request("GET", serve.PDFS_PATH)
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        return payload

    def saved_names(self):
        """Everything in PDFs/ (temp files included)."""
        return sorted(os.listdir(self.pdfs)) if os.path.isdir(self.pdfs) else []

    def temps(self):
        return [n for n in self.saved_names() if n.startswith(".marginalia-") and n.endswith(".tmp")]

    def file_name(self, book, data):
        return "%s [%s].pdf" % (book, sha_of(data)[:12])

    def notes(self):
        return [m for m in self.logged if m.startswith("PDFs:")]

    def wait_for(self, check, what, timeout=10):
        deadline = time.monotonic() + timeout
        while not check():
            if time.monotonic() > deadline:
                self.fail("waited in vain for " + what)
            time.sleep(0.005)

    def name(self, day=None):
        return "marginalia-backup-%s.json" % (day or self.day)

    @staticmethod
    def book(digit, **extra):
        """A book's collection record as the exporter writes it, its sha256 64 times `digit`."""
        return dict({"id": "b_" + digit, "kind": "book", "name": "Book " + digit, "sha256": digit * 64,
                     "hashAlgo": "sha-256", "hasBytes": True}, **extra)

    @staticmethod
    def backup_text(collections):
        return json.dumps({"format": "marginalia", "version": 1, "schedulerVersion": 1, "exportedAt": 1762650000000,
                           "scope": "all", "settings": {}, "collections": collections, "prompts": [],
                           "attachments": []}, indent=2, ensure_ascii=False)

    def post_backup(self, mode, collections):
        """POST /api/backup with a backup that lists `collections` -> its answer (status 200 checked)."""
        body = ('{"mode":"%s","backup":' % mode + self.backup_text(collections) + "}").encode("utf-8")
        status, _, payload, _ = self.request("POST", serve.BACKUP_PATH, body, post_headers(self.port))
        self.assertEqual(status, 200, payload)
        return payload

    def put_backup(self, day, collections=None, raw=None):
        os.makedirs(self.folder, exist_ok=True)
        data = raw if raw is not None else self.backup_text(collections or []).encode("utf-8")
        with open(os.path.join(self.folder, self.name(day)), "wb") as f:
            f.write(data)

    def put_pdf(self, name, data=SAVED_PDF):
        os.makedirs(self.pdfs, exist_ok=True)
        with open(os.path.join(self.pdfs, name), "wb") as f:
            f.write(data)

    def read(self, path):
        with open(path, "rb") as f:
            return f.read()

    # ---- POST /api/backup/pdf and GET /api/backup/pdfs

    def test_a_pdf_is_saved_once_as_a_normal_pdf_file(self):
        self.assertEqual(self.listing(), {"ok": True, "dir": serve.display_path(self.folder), "files": []})
        self.assertFalse(os.path.exists(self.folder), "a GET makes no folder")
        one = pdf_body("one", 3 * 1024 * 1024 + 5)                # several of the pieces it is read in
        status, headers, payload = self.upload(one, "Griffiths")
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers.get("cache-control"), "no-store")
        name = self.file_name("Griffiths", one)
        self.assertEqual(payload, {"ok": True, "file": name, "bytes": len(one), "skipped": False})
        self.assertEqual(self.read(os.path.join(self.pdfs, name)), one)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.pdfs, name)).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.pdfs).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.folder).st_mode) & 0o077, 0, "the folder is the user's alone")
        self.assertEqual(self.listing(), {"ok": True, "dir": serve.display_path(self.folder),
                                          "files": [{"sha12": sha_of(one)[:12], "name": name, "bytes": len(one)}]})
        # the same content under another name (a renamed book) is saved already
        status, _, payload = self.upload(one, "Griffiths, renamed")
        self.assertEqual((status, payload), (200, {"ok": True, "file": name, "bytes": len(one), "skipped": True}))
        # so is a copy renamed by hand: any name that ends in " [<sha12>].pdf"
        mine = "Quantum mechanics (my copy) [%s].pdf" % sha_of(one)[:12]
        os.rename(os.path.join(self.pdfs, name), os.path.join(self.pdfs, mine))
        status, _, payload = self.upload(one, "Griffiths")
        self.assertEqual((status, payload), (200, {"ok": True, "file": mine, "bytes": len(one), "skipped": True}))
        # another PDF: another file; the listing goes by name
        two = pdf_body("two")
        status, _, payload = self.upload(two, "Abbott")
        self.assertEqual((status, payload["file"], payload["skipped"]), (200, self.file_name("Abbott", two), False))
        self.assertEqual(self.listing()["files"], [
            {"sha12": sha_of(two)[:12], "name": self.file_name("Abbott", two), "bytes": len(two)},
            {"sha12": sha_of(one)[:12], "name": mine, "bytes": len(one)}])
        self.assertEqual(self.saved_names(), sorted([mine, self.file_name("Abbott", two)]), "no temp file is left")
        self.assertEqual(os.listdir(self.folder), [serve.PDF_FOLDER])

    def test_the_file_name_is_the_book_name_cleaned_as_an_obsidian_note_name_is(self):
        q = urllib.parse.quote
        cases = {
            q("Griffiths: Quantum/Mechanics..  2e"): "Griffiths QuantumMechanics\u2026 2e",
            q("../../etc/passwd"): "etcpasswd",
            "%2E%2E%2F%2E%2E%2Fescape": "escape",
            q(".hidden"): "hidden",
            q("  lead and trail .. "): "lead and trail",
            q('#tag ^block [[link]] a|b <c> "d" *e? \\f'): "tag block link ab c d e f",
            q("tab\tand\nnew line\u2028and\u00a0more\ufeff"): "tab and new line and more",
            "a%00b%01c%7Fd%C2%85e": "abcde",
            q("Book.pdf"): "Book", q("Book.PDF"): "Book", q("x .pdf"): "x", q("a.pdf.pdf"): "a.pdf",
            q("a" * 130): "a" * 120,
            q("x" * 119 + " y"): "x" * 119,
            q("\u6f22" * 60): "\u6f22" * 50,                          # 3 bytes each: at most 150 bytes
            q("\U0001f642" * 40): "\U0001f642" * 37,                  # 4 bytes each
            "%FF%FEok": "\ufffd\ufffdok",                             # not UTF-8
            "Caf%C3%A9": "Caf\u00e9",
            "Caf\u00c3\u00a9": "Caf\u00e9",                           # UTF-8 sent raw, as http.client reads it
            "": "Untitled", "%20%20": "Untitled", "...": "Untitled", "%2F": "Untitled", ".pdf": "pdf",
        }
        for header, book in cases.items():
            with self.subTest(header=header):
                self.assertEqual(serve.pdf_book_name(header), book)
        self.assertEqual(serve.pdf_book_name(None), "Untitled")
        # linear time on what a header can hold (64 KB): a trim pattern like [\s.]+$ took seconds on a run of dots
        t0 = time.monotonic()
        for header in ("a" + "." * 65000 + "b", "a" + " ." * 32000 + "b", "%2E" * 21000 + "a",
                       "a" + "%20" * 21000 + "b", ". " * 32000, "\t" * 65000):
            book = serve.pdf_book_name(header)
            self.assertTrue(book and len(book) <= serve.PDF_NAME_MAX and book[0] not in ". " and book[-1] not in ". ")
        self.assertLess(time.monotonic() - t0, 0.5)
        rnd = random.Random(9)
        sha = "0123456789abcdef" * 4
        for _ in range(2000):
            raw = bytes(rnd.choice(b"./\\:%\x00\x01 .\t\xc3\xa9\xff\xe2\x80\xa8ab") for _ in range(rnd.randint(0, 300)))
            book = serve.pdf_book_name(urllib.parse.quote(raw, safe=""))
            fname = serve.pdf_file_name(book, sha)
            self.assertTrue(book and len(book) <= serve.PDF_NAME_MAX and len(book.encode("utf-8")) <= 150, book)
            self.assertFalse(book[0] in ". " or book[-1] in ". ", book)
            self.assertFalse(set(book) & set('/\\\x00:*?"<>|#^[]'), book)
            self.assertEqual(os.path.basename(fname), fname)
            self.assertEqual(serve.PDF_FILE_RE.fullmatch(fname).group(1), sha[:12])
        # through the endpoint: a name never leads out of PDFs/; no name at all is "Untitled"
        data = pdf_body("escape")
        status, _, payload = self.upload(data, "../../escape")
        self.assertEqual((status, payload["file"]), (200, self.file_name("escape", data)), payload)
        other = pdf_body("nameless")
        status, _, payload = self.upload(other, headers={"X-Marginalia-Name": None})
        self.assertEqual((status, payload["file"]), (200, self.file_name("Untitled", other)), payload)
        self.assertEqual(self.saved_names(),
                         sorted([self.file_name("escape", data), self.file_name("Untitled", other)]))
        self.assertEqual(os.listdir(self.folder), [serve.PDF_FOLDER])
        self.assertEqual(sorted(os.listdir(self.base)), sorted(["Marginalia Backups", os.path.basename(self.outside)]))

    def test_a_body_that_is_not_the_pdf_it_claims_to_be_is_refused(self):
        good = pdf_body("good")
        for label, data, headers in [
                ("another PDF's SHA-256", good, {"X-Marginalia-Sha256": sha_of(pdf_body("other"))}),
                ("not a PDF", b"<html>" + os.urandom(2000), None),
                ("%PDF- ending past the first 1 KB", b" " * 1020 + b"%PDF-1.7\n" + os.urandom(100), None),
                ("an empty body", b"", None),
                ("no SHA-256", good, {"X-Marginalia-Sha256": None}),
                ("63 hex digits", good, {"X-Marginalia-Sha256": sha_of(good)[:63]}),
                ("65 hex digits", good, {"X-Marginalia-Sha256": sha_of(good) + "0"}),
                ("not hex", good, {"X-Marginalia-Sha256": "g" * 64})]:
            with self.subTest(label):
                status, headers_, payload = self.upload(data, "Refused", headers)
                self.assertEqual((status, payload["ok"]), (400, False), payload)
                self.assertTrue(payload["error"])
                self.assertEqual(headers_.get("cache-control"), "no-store")
                self.assertEqual(self.saved_names(), [], "nothing saved and no temp file left")
        # a short preamble before "%PDF-" (js/library.js takes such a PDF), and a SHA-256 in capitals
        preamble = b" " * 1019 + b"%PDF-1.4\n" + os.urandom(100)         # "%PDF-" ends at the 1024th byte
        status, _, payload = self.upload(preamble, "Preamble", {"X-Marginalia-Sha256": sha_of(preamble).upper()})
        self.assertEqual((status, payload["file"]), (200, self.file_name("Preamble", preamble)), payload)
        self.assertEqual(self.saved_names(), [self.file_name("Preamble", preamble)])

    def test_guards_refuse_before_anything_is_written(self):
        data = pdf_body("guarded")
        for label, headers, status in [("another site", {"Origin": "https://evil.example"}, 403),
                                       ("no Origin", {"Origin": None}, 403),
                                       ("no X-Marginalia", {"X-Marginalia": None}, 403),
                                       ("DNS rebinding", {"Host": "rebind.example:%d" % self.port}, 403),
                                       ("JSON", {"Content-Type": "application/json"}, 415),
                                       ("a form post", {"Content-Type": "text/plain"}, 415),
                                       ("bytes of any kind", {"Content-Type": "application/octet-stream"}, 415)]:
            with self.subTest(label):
                code, headers_, payload = self.upload(data, "Guarded", headers)
                self.assertEqual(code, status, payload)
                self.assertEqual(headers_.get("cache-control"), "no-store")
                self.assertFalse([k for k in headers_ if k.startswith("access-control-")], "no CORS")

        def announced(length):
            """A POST that announces `length` bytes (False: no Content-Length) and sends none -> status."""
            conn = self.start_upload(data, "Announced", length=length)
            try:
                return conn.getresponse().status
            finally:
                conn.close()
        self.assertEqual(announced(serve.MAX_PDF_BODY + 1), 413, "refused before the body is read")
        self.assertEqual(announced(False), 411)
        self.assertEqual(announced("x"), 400)
        self.assertEqual(serve.MAX_PDF_BODY, 300 * 1024 * 1024)
        for js in ("library.js", "store.js"):                           # the app's own limit for a PDF
            with open(os.path.join(APP, "js", js), encoding="utf-8") as f:
                self.assertRegex(f.read(), r"MAX_DOC_BYTES\s*=\s*300\s*\*\s*1024\s*\*\s*1024;", js)
        bytes_path = serve.PDF_PATH + "/" + sha_of(data)
        for path in (serve.PDFS_PATH, bytes_path):
            self.assertEqual(self.request("GET", path, headers={"Host": "rebind.example"})[0], 403, path)
            self.assertEqual(self.request("HEAD", path)[0], 404, path)
        self.assertEqual(self.request("OPTIONS", serve.PDF_PATH)[0], 501, "no preflight is ever answered")
        for method, path, body in [("GET", serve.PDFS_PATH, None), ("GET", bytes_path, None),
                                   ("POST", serve.PDF_PATH, data)]:
            status, payload = via_socket(self.httpd, ("192.168.1.20", 50000), method, path, body,
                                         self.pdf_headers(data) if body else None)
            self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden client"}), path)
        self.assertFalse(os.path.exists(self.folder), "nothing was written")

    # ---- GET /api/backup/pdf/<sha256>

    def test_a_saved_pdf_is_sent_only_when_its_content_is_what_was_asked(self):
        one = pdf_body("one", 2 * 1024 * 1024 + 3)
        self.assertEqual(self.upload(one, "B one")[0], 200)
        sha = sha_of(one)
        status, headers, _, raw = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, raw == one), (200, True))
        self.assertEqual(headers.get("content-type"), "application/pdf")
        self.assertEqual(headers.get("content-length"), str(len(one)))
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertFalse([k for k in headers if k.startswith("access-control-")], "no CORS")
        # the SHA-256 in capitals; a page of this very site, or an address typed in
        for site in (None, "same-origin", "none"):
            status, _, _, raw = self.request("GET", serve.PDF_PATH + "/" + sha.upper(),
                                             headers={"Sec-Fetch-Site": site} if site else None)
            self.assertEqual((status, raw == one), (200, True), site)
        # a page of another site gets nothing, not even an answer that tells a saved PDF apart
        for site in ("cross-site", "same-site"):
            status, _, payload, _ = self.request("GET", serve.PDF_PATH + "/" + sha, headers={"Sec-Fetch-Site": site})
            self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden site"}), site)
        # not saved, and paths that are not one SHA-256
        status, headers, payload, _ = self.request("GET", serve.PDF_PATH + "/" + "0" * 64)
        self.assertEqual((status, payload), (404, {"ok": False, "error": "no saved PDF has that SHA-256"}))
        self.assertEqual(headers.get("cache-control"), "no-store")
        for path in (serve.PDF_PATH, serve.PDF_PATH + "/", serve.PDF_PATH + "/" + sha[:63],
                     serve.PDF_PATH + "/" + sha + "0", serve.PDF_PATH + "/" + sha + "/",
                     serve.PDF_PATH + "/" + sha[:12], serve.PDF_PATH + "/" + "g" * 64, serve.PDFS_PATH + "/" + sha):
            status, _, payload, _ = self.request("GET", path)
            self.assertEqual((status, payload["ok"]), (404, False), path)
        # a file whose content is not what its name says is never sent (and is logged); the next one with that sha12 is
        decoy = "A decoy [%s].pdf" % sha[:12]
        self.put_pdf(decoy, b"%PDF-1.4\n% other bytes\n")
        status, _, _, raw = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, raw == one), (200, True))
        self.assertEqual(self.notes(), ["PDFs: the content of %s does not have the SHA-256 %s, so it was not sent"
                                        % (decoy, sha)])
        os.remove(os.path.join(self.pdfs, self.file_name("B one", one)))
        status, _, payload, _ = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, payload), (404, {"ok": False, "error": "no saved PDF has that SHA-256",
                                                   "changed": [decoy]}), "the 404 names the file that is not it")
        # a symlink with a saved PDF's name is never followed, not even to those very bytes
        os.remove(os.path.join(self.pdfs, decoy))
        target = os.path.join(self.outside, "elsewhere.pdf")
        with open(target, "wb") as f:
            f.write(one)
        os.symlink(target, os.path.join(self.pdfs, "Link [%s].pdf" % sha[:12]))
        self.assertEqual(self.request("GET", serve.PDF_PATH + "/" + sha)[0], 404)
        self.assertEqual(self.listing()["files"], [], "a symlink is no saved PDF")

    def test_a_pdf_that_changes_while_it_is_sent_never_arrives_whole(self):
        asked, now = pdf_body("asked", 5000), pdf_body("changed", 5000)
        sha = sha_of(asked)
        name = "Changing [%s].pdf" % sha[:12]
        self.put_pdf(name, now)                           # what the file holds by the time it is sent
        saved = serve.hashed_size, serve.PDF_CHUNK
        serve.hashed_size = lambda f, sha256: os.fstat(f.fileno()).st_size     # it held `asked` when it was hashed
        serve.PDF_CHUNK = 1000
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", serve.PDF_PATH + "/" + sha, headers={"Host": "127.0.0.1:%d" % self.port})
            r = conn.getresponse()
            self.assertEqual((r.status, r.getheader("Content-Length")), (200, str(len(now))))
            with self.assertRaises(http.client.IncompleteRead) as caught:
                r.read()
        finally:
            serve.hashed_size, serve.PDF_CHUNK = saved
            conn.close()
        part = caught.exception.partial
        self.assertLess(len(part), len(now), "the last piece was held back")
        self.assertEqual(part, now[:len(part)])
        self.assertIn("PDFs: %s changed while it was being sent, so its last part was held back" % name, self.notes())

    def test_a_saved_pdf_changed_after_it_was_saved_is_set_aside_and_saved_again(self):
        """Repair B9-R2: a saved PDF opened and saved in another app (Preview saving highlights into it) keeps its name
        but not its content. The listing goes by name (the page tells such a file by its size), the PDF's bytes are
        never sent from it (the 404 names it), and the next upload of that PDF renames it aside, with the user's
        changes, to a name that is never listed, sent or deleted, and saves the PDF in its place."""
        one = pdf_body("one", 3 * 1024 * 1024 + 5)
        sha, name = sha_of(one), self.file_name("Griffiths", one)
        path = os.path.join(self.pdfs, name)
        self.assertEqual(self.upload(one, "Griffiths")[2]["skipped"], False)
        highlight = b"\n9 0 obj << /Type /Annot /Subtype /Highlight >> endobj\n%%EOF\n"
        with open(path, "ab") as f:                       # an incremental update, the way PDF editors save one
            f.write(highlight)
        self.assertEqual(self.listing()["files"], [{"sha12": sha[:12], "name": name, "bytes": len(one + highlight)}])
        status, _, payload, _ = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, payload), (404, {"ok": False, "error": "no saved PDF has that SHA-256",
                                                   "changed": [name]}))
        self.assertEqual(self.read(path), one + highlight, "a GET renames nothing")
        self.logged.clear()
        status, _, payload = self.upload(one, "Griffiths")
        aside = "Griffiths [%s] (changed).pdf" % sha[:12]
        self.assertEqual((status, payload), (200, {"ok": True, "file": name, "bytes": len(one), "skipped": False,
                                                   "setAside": [{"name": name, "as": aside}]}))
        self.assertEqual((self.read(path), self.read(os.path.join(self.pdfs, aside))), (one, one + highlight))
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(self.notes(), ["PDFs: %s was changed after it was saved (its content is not that PDF any "
                                        "more), so it was renamed %s and is left alone from now on" % (name, aside)])
        self.assertEqual(self.listing()["files"], [{"sha12": sha[:12], "name": name, "bytes": len(one)}])
        status, _, _, raw = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, raw == one), (200, True))
        self.assertEqual(self.upload(one, "Griffiths")[2],
                         {"ok": True, "file": name, "bytes": len(one), "skipped": True})
        # changed again, keeping its size, by a new file renamed over it (an editor's safe save): the listing cannot
        # tell, the 404 can; then a copy renamed by hand holds the PDF: that copy counts, the changed one goes aside
        same_size = one[:-10] + b"0123456789"
        safe = os.path.join(self.outside, "safe-save.pdf")
        with open(safe, "wb") as f:
            f.write(same_size)
        os.replace(safe, path)
        self.assertEqual(self.listing()["files"], [{"sha12": sha[:12], "name": name, "bytes": len(one)}])
        status, _, payload, _ = self.request("GET", serve.PDF_PATH + "/" + sha)
        self.assertEqual((status, payload["changed"]), (404, [name]))
        mine = "My copy [%s].pdf" % sha[:12]
        self.put_pdf(mine, one)
        status, _, payload = self.upload(one, "Griffiths")
        aside2 = "Griffiths [%s] (changed 2).pdf" % sha[:12]
        self.assertEqual((status, payload), (200, {"ok": True, "file": mine, "bytes": len(one), "skipped": True,
                                                   "setAside": [{"name": name, "as": aside2}]}))
        self.assertEqual(self.saved_names(), sorted([aside, aside2, mine]))
        self.assertEqual(self.read(os.path.join(self.pdfs, aside2)), same_size)
        # a changed file that cannot be renamed: 500, nothing written, nothing left behind
        with open(os.path.join(self.pdfs, mine), "ab") as f:
            f.write(highlight)
        saved_link, saved_rename = os.link, os.rename

        def refused(real):
            def call(src, dst, **kw):
                if dst.endswith(").pdf"):
                    raise OSError(errno.EACCES, "Permission denied")
                return real(src, dst, **kw)
            return call
        os.link, os.rename = refused(saved_link), refused(saved_rename)
        try:
            status, _, payload = self.upload(one, "Griffiths")
        finally:
            os.link, os.rename = saved_link, saved_rename
        self.assertEqual((status, payload), (500, {"ok": False, "error": (
            "%s in the backup folder's PDFs folder was changed after it was saved (it is not that PDF any more), and "
            "it could not be renamed (Permission denied); nothing was written" % mine)}))
        self.assertEqual(self.saved_names(), sorted([aside, aside2, mine]), "no temp file is left")
        # the name a changed file gets never matches a saved PDF's, and stays within the 255 bytes a Mac's disk takes,
        # also for a name made longer by hand
        long_name = "%s [%s].pdf" % ("é" * 118, sha[:12])
        self.assertEqual(len(long_name.encode("utf-8")), 255)
        for n, tail in ((1, " (changed).pdf"), (2, " (changed 2).pdf"), (100, " (changed 100).pdf")):
            got = serve.aside_name(long_name, n)
            self.assertTrue(got.endswith(" [%s]%s" % (sha[:12], tail)) and got.startswith("é" * 100), got)
            self.assertLessEqual(len(got.encode("utf-8")), 255)
            self.assertIsNone(serve.PDF_FILE_RE.fullmatch(got))
        self.put_pdf(long_name, one + highlight)
        os.remove(os.path.join(self.pdfs, mine))
        status, _, payload = self.upload(one, "Griffiths")
        self.assertEqual((status, payload["file"], payload["skipped"]), (200, name, False), payload)
        self.assertEqual(payload["setAside"], [{"name": long_name, "as": serve.aside_name(long_name, 1)}])
        self.assertEqual(self.read(os.path.join(self.pdfs, serve.aside_name(long_name, 1))), one + highlight)
        self.assertEqual([f["name"] for f in self.listing()["files"]], [name])

    # ---- at once, failures, stops

    def test_two_uploads_of_one_pdf_at_once_leave_one_file(self):
        data = pdf_body("twice", 6 * 1024 * 1024)
        half = len(data) // 2
        a, b = self.start_upload(data, "First name"), self.start_upload(data, "Second name")
        try:
            a.send(data[:half])
            b.send(data[:half])
            # each body goes to disk as it comes, into a temp file of its own in PDFs/: never whole in memory
            self.wait_for(lambda: len(self.temps()) == 2 and all(
                os.path.getsize(os.path.join(self.pdfs, t)) >= 2 * serve.PDF_CHUNK for t in self.temps()),
                "both temp files to hold a part of their body")
            a.send(data[half:])
            b.send(data[half:])
            answers = []
            for conn in (a, b):
                r = conn.getresponse()
                answers.append((r.status, json.loads(r.read().decode("utf-8"))))
        finally:
            a.close()
            b.close()
        self.assertEqual([s for s, _ in answers], [200, 200], answers)
        self.assertEqual(sorted(p["skipped"] for _, p in answers), [False, True], answers)
        self.assertEqual(answers[0][1]["file"], answers[1][1]["file"], answers)
        self.assertIn(answers[0][1]["file"], (self.file_name("First name", data), self.file_name("Second name", data)))
        self.assertEqual(self.saved_names(), [answers[0][1]["file"]], "one file, and no temp file")
        self.assertEqual(self.read(os.path.join(self.pdfs, answers[0][1]["file"])), data)

    def test_a_failed_save_leaves_no_temp_file(self):
        data = pdf_body("failing")
        saved_link, saved_replace = os.link, os.replace

        def broken(real):
            def call(src, dst, **kw):
                if os.path.dirname(dst) == self.pdfs:
                    raise OSError(errno.EIO, "Input/output error")
                return real(src, dst, **kw)
            return call
        os.link, os.replace = broken(saved_link), broken(saved_replace)
        try:
            status, _, payload = self.upload(data, "Failing")
        finally:
            os.link, os.replace = saved_link, saved_replace
        self.assertEqual((status, payload), (500, {"ok": False, "error": "could not save the PDF: Input/output error"}))
        self.assertEqual(self.saved_names(), [], "no temp file is left")
        # a body cut off before its end (the page closed, the network went)
        conn = self.start_upload(data, "Cut off", length=len(data) + 1000)
        try:
            conn.send(data)
            self.wait_for(lambda: len(self.temps()) == 1, "the temp file")
        finally:
            conn.close()
        self.wait_for(lambda: self.temps() == [], "the temp file to be removed")
        self.assertEqual(self.saved_names(), [])

        # a disk without hard links (exFAT, some network disks): os.replace while the name is free
        def unsupported(src, dst, **kw):
            raise OSError(errno.ENOTSUP, "Operation not supported")
        os.link = unsupported
        try:
            status, _, payload = self.upload(data, "No links")
        finally:
            os.link = saved_link
        self.assertEqual((status, payload["skipped"]), (200, False), payload)
        self.assertEqual(self.saved_names(), [self.file_name("No links", data)])
        self.assertEqual(self.read(os.path.join(self.pdfs, self.file_name("No links", data))), data)
        # a file that appears under that very name meanwhile is never replaced: one that holds this very PDF counts as
        # saved; one that holds anything else is set aside (repair B9-R2: its content is never taken for this PDF) and
        # the PDF goes in its place
        other = pdf_body("racing")
        final = os.path.join(self.pdfs, self.file_name("Racing", other))
        meanwhile = b"%PDF-1.4\n% made meanwhile\n"

        def racing(content):
            made = []

            def call(src, dst, **kw):
                if dst == final and not made:
                    made.append(dst)
                    with open(dst, "wb") as f:
                        f.write(content)
                return saved_link(src, dst, **kw)
            return call
        for content in (other, meanwhile):
            os.link = racing(content)
            try:
                status, _, payload = self.upload(other, "Racing")
            finally:
                os.link = saved_link
            self.assertEqual(self.read(final), other)
            if content == other:
                self.assertEqual((status, payload), (200, {"ok": True, "file": os.path.basename(final),
                                                           "bytes": len(other), "skipped": True}))
                os.remove(final)
        aside = os.path.basename(final)[:-len(".pdf")] + " (changed).pdf"
        self.assertEqual((status, payload), (200, {"ok": True, "file": os.path.basename(final), "bytes": len(other),
                                                   "skipped": False,
                                                   "setAside": [{"name": os.path.basename(final), "as": aside}]}))
        self.assertEqual(self.read(os.path.join(self.pdfs, aside)), meanwhile)
        self.assertEqual(self.saved_names(), sorted([self.file_name("No links", data), os.path.basename(final), aside]))

    def test_a_stop_removes_the_temp_file_of_an_upload_under_way(self):
        data = pdf_body("stopped", 3 * 1024 * 1024)
        conn = self.start_upload(data, "Stopped")
        try:
            conn.send(data[:serve.PDF_CHUNK + 10])
            self.wait_for(lambda: len(self.temps()) == 1, "the temp file")
            ended, saved = [], serve.end_process
            serve.end_process = lambda signum: ended.append(signum)
            try:
                serve.stop_after_writes(15, None)
            finally:
                serve.end_process = saved
                for held in (serve.NOTE_LOCK, serve.BACKUP_LOCK):    # the handler keeps both: hand them back
                    if held.locked():
                        held.release()
            self.assertEqual(ended, [15])
            self.assertEqual(self.temps(), [], "the partial PDF went before the process would end")
            self.assertEqual(serve.PDF_TEMPS, set())
            conn.send(data[serve.PDF_CHUNK + 10:])                   # (a real stop has ended the server by now)
            r = conn.getresponse()
            r.read()
            self.assertEqual(r.status, 500)
        finally:
            conn.close()
        self.assertEqual(self.saved_names(), [], "nothing saved, nothing left")

    def test_a_name_held_by_a_folder_or_a_link_is_left_alone(self):
        data = pdf_body("held")
        name = self.file_name("Held", data)
        os.makedirs(os.path.join(self.pdfs, name))
        status, _, payload = self.upload(data, "Held")
        self.assertEqual((status, payload), (409, {"ok": False, "error": (
            "%s in the backup folder's PDFs folder is not a saved PDF (a folder, a link, or a file whose name differs "
            "only in letter case), so it is left as it is; nothing was written" % name)}))
        self.assertEqual(os.listdir(os.path.join(self.pdfs, name)), [])
        os.rmdir(os.path.join(self.pdfs, name))
        target = os.path.join(self.outside, "mine.pdf")
        with open(target, "wb") as f:
            f.write(b"my own file")
        os.symlink(target, os.path.join(self.pdfs, name))
        status, _, payload = self.upload(data, "Held")
        self.assertEqual(status, 409, payload)
        self.assertTrue(os.path.islink(os.path.join(self.pdfs, name)))
        self.assertEqual(self.read(target), b"my own file")
        self.assertEqual(self.saved_names(), [name], "no temp file is left")
        self.assertEqual(self.listing()["files"], [], "neither is a saved PDF")
        # under another book name it is saved
        status, _, payload = self.upload(data, "Held again")
        self.assertEqual((status, payload["file"], payload["skipped"]),
                         (200, self.file_name("Held again", data), False))
        # a file whose name differs only in letter case (".PDF": never a saved PDF): on a disk that ignores case
        # (macOS's default) our name reaches it, and it is left alone too
        case = pdf_body("case")
        variant = self.file_name("Case", case)[:-len(".pdf")] + ".PDF"
        self.put_pdf(variant, b"%PDF-1.4\n% the user's\n")
        ignores_case = os.path.lexists(os.path.join(self.pdfs, self.file_name("Case", case)))
        status, _, payload = self.upload(case, "Case")
        if ignores_case:
            self.assertEqual(status, 409, payload)
            self.assertEqual(self.read(os.path.join(self.pdfs, variant)), b"%PDF-1.4\n% the user's\n")
            self.assertNotIn(self.file_name("Case", case), os.listdir(self.pdfs))
        else:                                             # a disk that tells letter case apart: two names, two files
            self.assertEqual((status, payload["skipped"]), (200, False), payload)
            self.assertIn(variant, os.listdir(self.pdfs))
        self.assertEqual(self.temps(), [])

    def test_a_pdfs_folder_that_is_a_link_or_a_file_is_left_alone(self):
        data = pdf_body("linked")
        elsewhere = os.path.join(self.outside, "elsewhere")
        os.makedirs(elsewhere)
        unlisted = "Unlisted [%s].pdf" % ("d" * 12)
        with open(os.path.join(elsewhere, unlisted), "wb") as f:
            f.write(b"%PDF-1.4\n% mine\n")
        os.makedirs(self.folder)
        os.symlink(elsewhere, self.pdfs)
        status, _, payload, _ = self.request("GET", serve.PDFS_PATH)
        self.assertEqual(status, 500, payload)
        self.assertIn("PDFs in the backup folder %s is not a folder" % serve.display_path(self.folder),
                      payload["error"])
        status, _, payload = self.upload(data, "Linked")
        self.assertEqual((status, payload["ok"]), (500, False), payload)
        self.assertEqual(self.request("GET", serve.PDF_PATH + "/" + "d" * 64)[0], 500)
        payload = self.post_backup("auto", [self.book("a")])           # the backup is made; the prune touches nothing
        self.assertEqual(payload["skipped"], False)
        self.assertEqual(os.listdir(elsewhere), [unlisted])
        self.assertEqual(len(self.notes()), 1, self.notes())
        self.assertRegex(self.notes()[0],
                         r"^PDFs: nothing deleted, because PDFs in the backup folder .* is not a folder")
        os.remove(self.pdfs)
        with open(self.pdfs, "wb") as f:
            f.write(b"a file")
        self.assertEqual(self.request("GET", serve.PDFS_PATH)[0], 500)
        self.assertEqual(self.upload(data, "Linked")[0], 500)
        self.assertEqual(self.read(self.pdfs), b"a file")
        # and a backup folder that is a file
        os.remove(self.pdfs)
        shutil.rmtree(self.folder)
        with open(self.folder, "wb") as f:
            f.write(b"not a folder")
        status, _, payload, _ = self.request("GET", serve.PDFS_PATH)
        self.assertEqual(status, 500, payload)
        self.assertIn("could not read the backup folder", payload["error"])
        status, _, payload = self.upload(data, "Linked")
        self.assertEqual(status, 500, payload)
        self.assertIn("is not a folder", payload["error"])
        self.assertEqual(self.read(self.folder), b"not a folder")

    def test_a_server_without_a_backup_folder_has_no_pdf_api(self):
        httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, obsidian_config=os.path.join(self.base, "none.json"))
        t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        try:
            port = httpd.server_address[1]
            data = pdf_body("none")
            for method, path, body, headers in [
                    ("GET", serve.PDFS_PATH, None, None), ("GET", serve.PDF_PATH + "/" + sha_of(data), None, None),
                    ("POST", serve.PDF_PATH, data, dict(self.pdf_headers(data), Origin="http://127.0.0.1:%d" % port))]:
                status, _, payload, _ = http_request(port, method, path, body, headers)
                self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}), path)
        finally:
            httpd.shutdown()
            httpd.server_close()
            t.join(5)

    # ---- the prune after a JSON backup (B9.3)

    def test_the_prune_keeps_every_pdf_a_kept_backup_lists_and_deletes_only_unlisted_saved_ones(self):
        days = ["2026-10-%02d" % d for d in range(10, 32)] + ["2026-11-%02d" % d for d in range(1, 9)]
        self.assertEqual(len(days), serve.BACKUP_KEEP)            # with today's: one more than are kept
        # the PDFs that go hold what their names say (the prune hashes each one first); the kept ones are never hashed
        held = {k: ("%PDF-1.4\n% book " + k + "\n").encode("utf-8") for k in ("c", "d", "1", "e")}
        sha = {k: sha_of(v) for k, v in held.items()}
        for d in days:
            self.put_backup(d, [self.book("a")])
        self.put_backup(days[0], [self.book("c", sha256=sha["c"])])     # pushed out by today's backup: its PDFs go
        self.put_backup(days[1], [self.book("b"), {"id": "d_1", "kind": "deck", "name": "A deck"}])  # the oldest kept
        # D23 (2026-11-11): a book deleted more than 30 days ago (2025-11-09): its tombstone lists nothing
        self.put_backup(days[2], [self.book("e", sha256=sha["e"], deletedAt=1762650000000)])
        self.put_backup(days[3], [self.book("F")])                # its SHA-256 in capitals
        self.put_backup(days[4], [self.book("1", sha256=sha["1"][:63])])     # not a SHA-256: lists nothing
        # the same PDF in a deleted book and in a live one: the live one lists it, in either order
        self.put_backup(days[5], [self.book("2", deletedAt=1762650000000), self.book("3", sha256="2" * 64)])
        self.put_backup(days[8], [self.book("5", sha256="6" * 64), self.book("6", deletedAt=1762650000000)])
        self.put_backup(days[6], [self.book("4")])                # alive in an older kept backup ...
        self.put_backup(days[7], [self.book("4", deletedAt=1762650000000)])  # ... and deleted since: still kept
        kept = ["Book a [%s].pdf" % ("a" * 12), "Book b [%s].pdf" % ("b" * 12), "Book f [%s].pdf" % ("f" * 12),
                "Book 2 [%s].pdf" % ("2" * 12), "Book 4 [%s].pdf" % ("4" * 12), "Book 6 [%s].pdf" % ("6" * 12)]
        gone = {"Book c [%s].pdf" % sha["c"][:12]: held["c"], "Book d [%s].pdf" % sha["d"][:12]: held["d"],
                "Renamed by hand [%s].pdf" % sha["d"][:12]: held["d"], " [%s].pdf" % sha["1"][:12]: held["1"],
                "Book e [%s].pdf" % sha["e"][:12]: held["e"]}
        unlisted = "9" * 12
        decoys = ["Capitals [%s].PDF" % unlisted, "Hex in capitals [99999999999A].pdf",
                  "Short [%s].pdf" % unlisted[:11], "Long [%s9].pdf" % unlisted, "Parentheses (%s).pdf" % unlisted,
                  "No space[%s].pdf" % unlisted, "Temp [%s].pdf.tmp" % unlisted, ".marginalia-left.tmp",
                  "._Book [%s].pdf" % unlisted, ".hidden [%s].pdf" % unlisted, "Trailing space [%s].pdf " % unlisted,
                  "Set aside [%s] (changed).pdf" % unlisted, "notes.txt"]
        for n in kept + decoys:
            self.put_pdf(n, ("%PDF-1.4\n% " + n + "\n").encode("utf-8"))
        for n, data in gone.items():
            self.put_pdf(n, data)
        os.makedirs(os.path.join(self.pdfs, "A folder [%s].pdf" % unlisted))
        target = os.path.join(self.outside, "target.pdf")
        with open(target, "wb") as f:
            f.write(b"my file")
        os.symlink(target, os.path.join(self.pdfs, "A link [%s].pdf" % unlisted))
        payload = self.post_backup("auto", [self.book("a")])
        self.assertEqual((payload["skipped"], payload["pruned"]), (False, [self.name(days[0])]), payload)
        self.assertEqual(self.notes(), ["PDFs: deleted %d that no kept backup lists: %s"
                                        % (len(gone), ", ".join(sorted(gone)))])
        self.assertEqual(self.saved_names(), sorted(kept + decoys + ["A folder [%s].pdf" % unlisted,
                                                                     "A link [%s].pdf" % unlisted]))
        for n in kept + decoys:
            self.assertEqual(self.read(os.path.join(self.pdfs, n)), ("%PDF-1.4\n% " + n + "\n").encode("utf-8"), n)
        self.assertTrue(os.path.islink(os.path.join(self.pdfs, "A link [%s].pdf" % unlisted)))
        self.assertEqual(self.read(target), b"my file")
        self.assertEqual([f["name"] for f in self.listing()["files"]], sorted(kept), "decoys are never listed either")

    def test_a_deleted_books_pdf_stays_30_days_after_the_deletion(self):
        # D23 (2026-11-11): a tombstone keeps its PDF for DELETED_PDF_DAYS (30) days from its deletedAt, whatever the
        # backups list; then the next backup written deletes it, unless a kept backup still lists the book alive. Here
        # the book comes and goes on one day, with "Back up now" after each (review safety-1): once today's file is
        # replaced, no kept backup lists it alive, yet its PDF stays the 30 days.
        held = b"%PDF-1.4\n% a book deleted the day it came\n"
        alive = self.book("9", sha256=sha_of(held))
        name = "Book 9 [%s].pdf" % sha_of(held)[:12]
        self.put_backup("2026-11-08", [self.book("a")])
        self.post_backup("manual", [self.book("a"), alive])      # Back up now: the book alive, then its PDF saved
        self.put_pdf(name, held)
        dead = dict(alive, deletedAt=self.now - 3600 * 1000)       # deleted an hour ago
        self.post_backup("manual", [self.book("a"), dead])       # Back up now again: today's file replaced
        self.assertEqual(self.saved_names(), [name])
        self.day, self.now = "2026-11-10", NOON_MS + DAY_MS
        self.post_backup("auto", [self.book("a"), dead])
        self.assertEqual(self.saved_names(), [name])
        # a backup of another library that never had the book (Brave's cover, say) replaces today's file: yesterday's
        # kept file still holds the recent tombstone, and that keeps the PDF
        self.post_backup("manual", [self.book("a")])
        self.assertEqual(self.saved_names(), [name])
        self.day, self.now = "2026-12-08", NOON_MS + 29 * DAY_MS
        self.post_backup("auto", [self.book("a"), dead])
        self.assertEqual(self.saved_names(), [name])
        self.assertEqual(self.notes(), [])
        self.day, self.now = "2026-12-09", NOON_MS + 30 * DAY_MS      # 30 days and an hour after the deletion
        self.post_backup("auto", [self.book("a"), dead])
        self.assertEqual(self.saved_names(), [])
        self.assertEqual(self.notes(), ["PDFs: deleted 1 that no kept backup lists: " + name])

    def test_older_kept_backups_keep_a_tombstones_pdf_the_whole_30_days(self):
        # review9 (DOCS-1): the book comes and goes on 2026-11-09 (Back up now after each); 29 days later another
        # library's backup replaces the day's file, so only 2026-11-09's kept file holds the tombstone: it keeps the PDF
        # through prune_pdfs' own cutoff until the 30 days are over
        held = b"%PDF-1.4\n% older kept backups\n"
        alive = self.book("9", sha256=sha_of(held))
        name = "Book 9 [%s].pdf" % sha_of(held)[:12]
        self.put_backup("2026-11-08", [self.book("a")])
        self.post_backup("manual", [self.book("a"), alive])
        self.put_pdf(name, held)
        dead = dict(alive, deletedAt=self.now - 3600 * 1000)
        self.post_backup("manual", [self.book("a"), dead])
        self.day, self.now = "2026-12-08", NOON_MS + 29 * DAY_MS
        self.post_backup("manual", [self.book("a")])            # another library's backup: no record of the book
        self.assertEqual(self.saved_names(), [name], "29 days after the deletion the PDF is still there")
        self.day, self.now = "2026-12-09", NOON_MS + 30 * DAY_MS
        self.post_backup("manual", [self.book("a")])
        self.assertEqual(self.saved_names(), [])

    def test_the_backup_just_written_keeps_a_tombstones_pdf_the_whole_30_days(self):
        # review9 (DOCS-2): the backup just written is the only one that knows the book (no other backup in the folder),
        # so the POST's own cutoff decides: 29 days after the deletion kept, 30 days and a millisecond gone
        held = b"%PDF-1.4\n% the backup just written\n"
        alive = self.book("9", sha256=sha_of(held))
        name = "Book 9 [%s].pdf" % sha_of(held)[:12]
        self.put_pdf(name, held)
        self.post_backup("manual", [self.book("a"), dict(alive, deletedAt=self.now - 29 * DAY_MS)])
        self.assertEqual(self.saved_names(), [name], "deleted 29 days ago: kept")
        self.post_backup("manual", [self.book("a"), dict(alive, deletedAt=self.now - 30 * DAY_MS - 1)])
        self.assertEqual(self.saved_names(), [], "deleted 30 days and a millisecond ago: gone")

    def test_a_pdf_uploaded_while_a_backup_ran_stays_after_its_books_deletion(self):
        # review8 safety-2: the day's backup is written without book X (added while it ran) and X's PDF is uploaded
        # right after; X is deleted an hour later, and the next backup written, two days later, holds only X's tombstone
        held = b"%PDF-1.4\n% added while the backup ran\n"
        self.post_backup("auto", [self.book("a")])
        status, _, payload = self.upload(held, "Book X")
        self.assertEqual(status, 200, payload)
        dead = {"id": "b_x", "kind": "book", "name": "Book X", "sha256": sha_of(held), "hashAlgo": "sha-256",
                "deletedAt": self.now + 3600 * 1000}
        self.day, self.now = "2026-11-11", NOON_MS + 2 * DAY_MS
        self.post_backup("auto", [self.book("a"), dead])
        self.assertEqual(self.saved_names(), [self.file_name("Book X", held)], "deleted 47 hours ago: the PDF stays")
        self.assertEqual(self.notes(), [])

    def test_a_pdf_deleted_over_30_days_ago_stays_while_a_kept_backup_lists_the_book_alive(self):
        # D23: a tombstone older than DELETED_PDF_DAYS lists nothing, but a kept backup that lists the book alive (as
        # when Marginalia made no backup for a while) keeps its PDF until the JSON prune removes that backup; the PDF
        # then goes in that same request (prune_backups runs before prune_pdfs)
        held = b"%PDF-1.4\n% a book deleted later\n"
        alive = self.book("9", sha256=sha_of(held))
        dead = dict(alive, deletedAt=self.now - 31 * DAY_MS)
        days = ["2026-10-%02d" % d for d in range(10, 32)] + ["2026-11-%02d" % d for d in range(1, 9)]
        self.assertEqual(len(days), serve.BACKUP_KEEP)
        for d in days:
            self.put_backup(d, [dead])
        self.put_backup(days[0], [alive])
        self.put_backup(days[1], [alive])                         # the last backup that lists the book alive
        name = "Book 9 [%s].pdf" % sha_of(held)[:12]
        self.put_pdf(name, held)
        payload = self.post_backup("auto", [dead])                # days[0] goes; days[1] still lists the book alive
        self.assertEqual(payload["pruned"], [self.name(days[0])])
        self.assertEqual(self.saved_names(), [name])
        self.assertEqual(self.notes(), [])
        self.day, self.now = "2026-11-10", self.now + DAY_MS
        payload = self.post_backup("auto", [dead])                # days[1] goes, and the PDF with it
        self.assertEqual(payload["pruned"], [self.name(days[1])])
        self.assertEqual(self.saved_names(), [])
        self.assertEqual(self.notes(), ["PDFs: deleted 1 that no kept backup lists: " + name])

    def test_a_tombstone_is_read_as_the_exporter_reads_deletedAt(self):
        # D23: js/exporter.js stampOf reads deletedAt as a tombstone only when it is a number, finite and above 0;
        # anything else is a live book, whose PDF stays (when in doubt, a PDF is kept). A tombstone keeps its PDF
        # while its deletedAt is at or after the cutoff (tombstone_cutoff(): DELETED_PDF_DAYS before now).
        inf = float("inf")                                        # a cutoff that makes every tombstone an old one
        for stamp in (1762650000000, 1, 0.5, 1e308, 5e-324, 1.7976931348623157e308):
            with self.subTest(stamp=stamp):
                self.assertIs(serve.is_tombstone(stamp), True)
                self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=stamp)], inf), set())
                self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=stamp)], stamp), {"a" * 12})
        for stamp in (None, 0, 0.0, -0.0, -1, "1762650000000", "", True, False, float("inf"), float("-inf"),
                      float("nan"), 10 ** 400, [], {}):
            with self.subTest(stamp=stamp):
                self.assertIs(serve.is_tombstone(stamp), False)
                self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=stamp)], inf), {"a" * 12})
        self.assertEqual(serve.collection_sha12s([self.book("a")], inf), {"a" * 12}, "no deletedAt: a live book")
        # the cutoff: at it or after it (a Mac clock that was ahead) a tombstone keeps its PDF, before it not
        self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=1000)], 1000.0), {"a" * 12})
        self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=999.5)], 1000.0), set())
        self.assertEqual(serve.collection_sha12s([self.book("a", deletedAt=self.now + 5 * DAY_MS)],
                                                 serve.tombstone_cutoff()), {"a" * 12})
        self.assertEqual(serve.tombstone_cutoff(), self.now - serve.DELETED_PDF_DAYS * DAY_MS)
        self.assertLess(abs(self.saved_now() - time.time() * 1000), 5000, "the real clock counts milliseconds")
        self.assertEqual(serve.DELETED_PDF_DAYS, 30)
        # the same PDF in an old tombstone and in a live book stays listed, in either order
        for books in ([self.book("a", deletedAt=5), self.book("b", sha256="A" * 64)],
                      [self.book("b", sha256="A" * 64), self.book("a", deletedAt=5)]):
            self.assertEqual(serve.collection_sha12s(books, inf), {"a" * 12}, "a live book keeps a shared PDF")
        with self.assertRaises(ValueError):                       # a tombstone never hides a malformed collection
            serve.collection_sha12s([self.book("a", deletedAt=5), "b_x"], inf)
        # as JSON reads them: a number too large for a float, written out or with an exponent, is a live book, and
        # neither stops the backup that lists it nor makes its PDF go
        name = "Book a [%s].pdf" % ("a" * 12)
        self.put_pdf(name)
        for raw in ("1" + "0" * 400, "1e400"):
            with self.subTest(raw=raw[:8]):
                text = self.backup_text([self.book("a", deletedAt=0)])
                self.assertEqual(text.count('"deletedAt": 0'), 1)
                body = ('{"mode":"manual","backup":' + text.replace('"deletedAt": 0', '"deletedAt": ' + raw)
                        + "}").encode("utf-8")
                status, _, payload, _ = self.request("POST", serve.BACKUP_PATH, body, post_headers(self.port))
                self.assertEqual(status, 200, payload)
                self.assertEqual(self.saved_names(), [name])
                self.assertEqual(self.notes(), [])

    def test_nothing_is_deleted_while_a_kept_backup_cannot_be_read_or_parsed(self):
        unlisted = "Unlisted [%s].pdf" % SAVED_12
        good = json.loads(self.backup_text([self.book("a")]))
        not_parsed = "cannot be parsed"
        not_backup = "is not a Marginalia backup"
        bad = [("broken JSON", b"{", not_parsed), ("empty", b"", not_parsed),
               ("not UTF-8", b'{"format": "marginalia", "x": "\xff"}', not_parsed),
               ("NaN", self.backup_text([self.book("a")]).replace('"version": 1', '"version": 1, "x": NaN')
                .encode("utf-8"), not_parsed),
               ("nested too deep", self.backup_text([]).replace(              # parsed or not: never a collection
                   '"collections": []', '"collections": [' + "[" * 100000 + "]" * 100000 + "]").encode("utf-8"),
                not_parsed),
               ("a collection that is not an object", json.dumps(dict(good, collections=["b_a"])).encode("utf-8"),
                not_parsed),
               ("a list", b"[]", not_backup),
               ("another format", json.dumps(dict(good, format="anki")).encode("utf-8"), not_backup),
               ("collections not a list", json.dumps(dict(good, collections={})).encode("utf-8"), not_backup)]
        for label, raw, why in bad:
            with self.subTest(label):
                self.logged.clear()
                self.put_pdf(unlisted)
                self.put_backup("2026-11-08", raw=raw)
                self.post_backup("manual", [self.book("a")])
                self.assertIn(unlisted, self.saved_names())
                self.assertEqual(self.notes(),
                                 ["PDFs: nothing deleted, because %s %s" % (self.name("2026-11-08"), why)])
        self.put_backup("2026-11-08", [self.book("a")])
        locked = os.path.join(self.folder, self.name("2026-11-08"))
        os.chmod(locked, 0)
        try:
            if not os.access(locked, os.R_OK):                    # running as root: chmod 0 does not lock it
                self.logged.clear()
                self.post_backup("manual", [self.book("a")])
                self.assertIn(unlisted, self.saved_names())
                self.assertEqual(self.notes(), ["PDFs: nothing deleted, because %s cannot be read (Permission denied)"
                                                % self.name("2026-11-08")])
        finally:
            os.chmod(locked, 0o600)
        # the backup just written, when its collections are not what the exporter writes
        self.logged.clear()
        self.post_backup("manual", ["b_a"])
        self.assertIn(unlisted, self.saved_names())
        self.assertEqual(self.notes(), ["PDFs: nothing deleted, because %s lists its collections in a form Marginalia "
                                        "does not read" % self.name()])
        # once every kept backup reads, the PDF none of them lists goes
        self.logged.clear()
        self.post_backup("manual", [self.book("a")])
        self.assertNotIn(unlisted, self.saved_names())
        self.assertEqual(self.notes(), ["PDFs: deleted 1 that no kept backup lists: " + unlisted])

    def test_the_prune_runs_after_each_backup_written_and_never_after_a_skip(self):
        self.post_backup("auto", [self.book("a")])
        self.assertEqual(os.listdir(self.folder), [self.name()], "a backup makes no PDFs folder")
        listed, unlisted = "Book a [%s].pdf" % ("a" * 12), "Unlisted [%s].pdf" % SAVED_12
        self.put_pdf(listed)
        self.put_pdf(unlisted)
        payload = self.post_backup("auto", [self.book("a")])      # today's backup is there: skipped, no prune
        self.assertEqual(payload["skipped"], True)
        self.assertEqual(self.saved_names(), [listed, unlisted])
        self.post_backup("manual", [self.book("a")])              # "Back up now"
        self.assertEqual(self.saved_names(), [listed])
        self.put_pdf(unlisted)
        self.day = "2026-11-10"
        self.assertEqual(self.post_backup("auto", [self.book("a")])["skipped"], False)    # the next day's
        self.assertEqual(self.saved_names(), [listed])
        self.assertEqual(self.notes(), ["PDFs: deleted 1 that no kept backup lists: " + unlisted] * 2)

    def test_the_prune_never_raises_and_deletes_nothing_it_cannot_vouch_for(self):
        self.put_backup(self.day, [self.book("a")])
        unlisted = "Unlisted [%s].pdf" % SAVED_12
        self.put_pdf(unlisted)
        notes = []
        self.assertEqual(serve.prune_pdfs(self.folder, self.name("2026-11-10"), {"a" * 12}, notes.append), [])
        self.assertEqual(notes, ["PDFs: nothing deleted, because the backup just written, %s, is not among the "
                                 "backups" % self.name("2026-11-10")])
        saved = serve.backup_files
        serve.backup_files = lambda folder: 1 / 0
        try:
            notes = []
            self.assertEqual(serve.prune_pdfs(self.folder, self.name(), {"a" * 12}, notes.append), [])
        finally:
            serve.backup_files = saved
        self.assertTrue(notes[0].startswith("PDFs: nothing deleted, because of an unexpected error\n"), notes)
        self.assertIn("ZeroDivisionError", notes[0])
        self.assertEqual(self.saved_names(), [unlisted])
        self.assertEqual(serve.prune_pdfs(self.folder, self.name(), {"a" * 12}), [unlisted], "no log needed")
        self.assertEqual(serve.prune_pdfs(os.path.join(self.base, "missing"), self.name(), set()), [])

    def test_the_prune_never_deletes_a_saved_pdf_changed_after_it_was_saved(self):
        """Repair B9-R2: the prune hashes each saved PDF no kept backup lists and deletes only one that still holds
        what its name says. One changed after it was saved (opened and saved in another app) holds the user's own
        work: it is set aside, never deleted; one that cannot be read stays."""
        gone, locked = "Gone [%s].pdf" % SAVED_12, "Locked [%s].pdf" % SAVED_12
        self.put_pdf(gone)
        held = b"%PDF-1.4\n% as it was saved\n"
        changed = "Changed [%s].pdf" % sha_of(held)[:12]
        self.put_pdf(changed, held + b"% a highlight\n")
        self.put_pdf(locked)
        os.chmod(os.path.join(self.pdfs, locked), 0)
        readable = os.access(os.path.join(self.pdfs, locked), os.R_OK)        # running as root: chmod 0 locks nothing
        self.post_backup("manual", [self.book("a")])
        aside = "Changed [%s] (changed).pdf" % sha_of(held)[:12]
        self.assertEqual(self.read(os.path.join(self.pdfs, aside)), held + b"% a highlight\n")
        notes = ["PDFs: %s was changed after it was saved (its content is not that PDF any more), so it was renamed "
                 "%s and is left alone from now on" % (changed, aside)]
        if readable:
            self.assertEqual(self.saved_names(), [aside])
            notes.append("PDFs: deleted 2 that no kept backup lists: %s, %s" % (gone, locked))
        else:
            self.assertEqual(self.saved_names(), sorted([aside, locked]))
            notes += ["PDFs: %s cannot be read, so it was not deleted" % locked,
                      "PDFs: deleted 1 that no kept backup lists: " + gone]
        self.assertEqual(self.notes(), notes)
        # from then on that file is no saved PDF: never listed, never touched by the next backups
        self.assertNotIn(aside, [f["name"] for f in self.listing()["files"]])
        self.day = "2026-11-10"
        self.post_backup("auto", [self.book("a")])
        self.assertIn(aside, self.saved_names())


class ServerOptionsTest(unittest.TestCase):
    """--obsidian-config and --obsidian-sandbox: a test server can be pointed at a throwaway vault from its command line
    (.claude/launch.json cannot set environment variables). The sandbox keeps a test page in server mode only while
    that server answers and its vault folder exists: once it stops, the page falls back to obsidian:// links like any
    other page (they would reach the real Obsidian), so a browser test always stubs the opener."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-options-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @contextlib.contextmanager
    def fake_home(self):
        """HOME = a fake home in the temp folder whose Obsidian config lists "Decoy Vault" (also in the temp folder),
        MARGINALIA_OBSIDIAN_CONFIG unset: what a fallback to "Obsidian's own list" would reach here. -> the decoy."""
        home = os.path.join(self.tmp, "home")
        folder = os.path.join(home, "Library", "Application Support", "obsidian")
        decoy = os.path.join(self.tmp, "Decoy Vault")
        os.makedirs(folder)
        os.makedirs(os.path.join(decoy, ".obsidian"))
        with open(os.path.join(folder, "obsidian.json"), "w", encoding="utf-8") as f:
            json.dump({"vaults": {"d1": {"path": decoy, "ts": 1, "open": True}}, "frame": "hidden"}, f)
        saved = {k: os.environ.get(k) for k in ("HOME", serve.CONFIG_ENV)}
        os.environ["HOME"] = home
        os.environ.pop(serve.CONFIG_ENV, None)
        try:
            self.assertEqual(serve.default_config_path(), os.path.join(folder, "obsidian.json"))
            yield decoy
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def run_cli(self, *argv, env=None):
        """tools/serve.py as `marginalia` runs it, with HOME = the fake home and MARGINALIA_BACKUP_DIR = a temp folder
        unless `env` says otherwise (None removes a variable) (port 0; killed if it ever serves).
        -> (exit code, stdout, stderr)."""
        e = {"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
             serve.BACKUP_ENV: os.path.join(self.tmp, "cli-backups")}
        e.update(env or {})
        e = {k: v for k, v in e.items() if v is not None}
        cwd = os.path.join(self.tmp, "cwd")
        os.makedirs(cwd, exist_ok=True)
        p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP] + list(argv), cwd=cwd,
                             env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()
        return p.returncode, out, err

    def test_a_blank_option_or_variable_stops_the_server_instead_of_using_obsidians_own_list(self):
        with self.fake_home() as decoy:
            for argv in (["--obsidian-sandbox", ""], ["--obsidian-sandbox="], ["--obsidian-sandbox", "  "],
                         ["--obsidian-config", ""], ["--obsidian-config="]):
                with self.subTest(argv=argv):
                    with self.assertRaises(ValueError):
                        serve.startup_config(serve.parse_args(argv))
            os.environ[serve.CONFIG_ENV] = ""
            try:
                with self.assertRaises(ValueError):
                    serve.startup_config(serve.parse_args([]))
                self.assertIsNone(serve.config_from_environment())
                status, payload = self.get_vaults(None)        # a server started some other way lists no vault
                self.assertEqual((status, payload), (200, {"vaults": [], "replaceOnly": True}))
            finally:
                os.environ.pop(serve.CONFIG_ENV, None)
            self.assertEqual(self.get_vaults("")[1], {"vaults": [], "replaceOnly": True},
                             "a blank make_server config lists no vault")
            code, out, err = self.run_cli("--obsidian-sandbox", "")
            self.assertEqual((code, out), (1, ""), err)
            self.assertIn("--obsidian-sandbox needs a folder", err)
            code, out, err = self.run_cli(env={serve.CONFIG_ENV: ""})
            self.assertEqual((code, out), (1, ""), err)
            self.assertIn(serve.CONFIG_ENV + " is set but empty", err)
            self.assertEqual(os.listdir(os.path.join(self.tmp, "cwd")), [], "no sandbox was made anywhere")
            self.assertEqual(os.listdir(decoy), [".obsidian"])

    def get_vaults(self, config):
        httpd = serve.make_server(APP, "127.0.0.1", 0, obsidian_config=config, quiet=True,
                                  backup_dir=os.path.join(self.tmp, "backups"))
        t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        try:
            port = httpd.server_address[1]
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("GET", "/api/obsidian/vaults", headers={"Host": "127.0.0.1:%d" % port})
            r = conn.getresponse()
            payload = json.loads(r.read().decode("utf-8"))
            conn.close()
            return r.status, payload
        finally:
            httpd.shutdown()
            httpd.server_close()
            t.join(5)

    def test_obsidian_config_wins_over_the_environment(self):
        vault = os.path.join(self.tmp, "Option Vault")
        os.makedirs(vault)
        config = os.path.join(self.tmp, "obsidian.json")
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {"o1": {"path": vault, "open": True}}}, f)
        args = serve.parse_args(["--port", "0", "--obsidian-config", config])
        self.assertEqual(serve.obsidian_config_of(args), config)
        self.assertIsNone(serve.obsidian_config_of(serve.parse_args(["--port", "0"])), "no option: the environment")
        old = os.environ.get(serve.CONFIG_ENV)
        os.environ[serve.CONFIG_ENV] = os.path.join(self.tmp, "missing.json")   # throwaway too, and it lists nothing
        try:
            status, payload = self.get_vaults(serve.obsidian_config_of(args))
        finally:
            if old is None:
                os.environ.pop(serve.CONFIG_ENV, None)
            else:
                os.environ[serve.CONFIG_ENV] = old
        self.assertEqual(status, 200)
        self.assertEqual([v["name"] for v in payload["vaults"]], ["Option Vault"])

    def test_the_two_options_exclude_each_other(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            serve.parse_args(["--obsidian-config", "a.json", "--obsidian-sandbox", "b"])

    def test_sandbox_creates_its_vault_and_names_only_it(self):
        folder = os.path.join(self.tmp, "sandbox")
        config = serve.obsidian_config_of(serve.parse_args(["--obsidian-sandbox", folder]))
        self.assertEqual(config, os.path.join(folder, "obsidian.json"))
        with open(config, encoding="utf-8") as f:
            listed = json.load(f)["vaults"]
        self.assertEqual([v["path"] for v in listed.values()], [os.path.join(folder, serve.SANDBOX_VAULT)])
        with open(os.path.join(folder, serve.SANDBOX_VAULT, ".obsidian", "app.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["attachmentFolderPath"], "Attachments")
        status, payload = self.get_vaults(config)
        self.assertEqual((status, [v["name"] for v in payload["vaults"]]), (200, [serve.SANDBOX_VAULT]))
        # the next start rewrites the sandbox's own list
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {serve.SANDBOX_ID: {"path": os.path.join(folder, serve.SANDBOX_VAULT), "open": False}}}, f)
        self.assertEqual(serve.make_sandbox(folder), config)
        with open(config, encoding="utf-8") as f:
            self.assertIs(json.load(f)["vaults"][serve.SANDBOX_ID]["open"], True)
        # an edited list that names another vault is not the sandbox's own: refused and left as it is, so the
        # sandbox still never names another vault
        other = os.path.join(self.tmp, "Other")
        os.makedirs(other)
        edited = json.dumps({"vaults": {"x": {"path": other, "open": True}}})
        with open(config, "w", encoding="utf-8") as f:
            f.write(edited)
        with self.assertRaises(ValueError):
            serve.make_sandbox(folder)
        with open(config, encoding="utf-8") as f:
            self.assertEqual(f.read(), edited)

    def test_a_stop_waits_for_the_write_in_progress(self):
        for lock in (serve.NOTE_LOCK, serve.BACKUP_LOCK):    # what write_note and write_backup hold while writing
            with self.subTest(lock="NOTE_LOCK" if lock is serve.NOTE_LOCK else "BACKUP_LOCK"):
                ended, released = [], []

                def writer():
                    with lock:
                        time.sleep(0.3)
                        released.append(time.monotonic())
                saved = serve.end_process
                serve.end_process = lambda signum: ended.append((signum, time.monotonic()))
                t = threading.Thread(target=writer)
                t.start()
                try:
                    time.sleep(0.05)
                    serve.stop_after_writes(15, None)
                finally:
                    serve.end_process = saved
                    t.join(5)
                    for held in (serve.NOTE_LOCK, serve.BACKUP_LOCK):    # the handler keeps both: hand them back
                        if held.locked():
                            held.release()
                self.assertEqual(len(ended), 1)
                self.assertEqual(ended[0][0], 15)
                self.assertGreaterEqual(ended[0][1], released[0], "the process ends only after the write")

    def test_a_stop_waits_at_most_stop_wait_in_all(self):
        go = threading.Event()

        def stuck(lock):
            with lock:
                go.wait(10)
        threads = [threading.Thread(target=stuck, args=(lock,)) for lock in (serve.NOTE_LOCK, serve.BACKUP_LOCK)]
        for t in threads:
            t.start()
        ended = []
        saved_end, saved_wait = serve.end_process, serve.STOP_WAIT
        serve.end_process, serve.STOP_WAIT = (lambda signum: ended.append(time.monotonic())), 0.3
        try:
            time.sleep(0.05)
            t0 = time.monotonic()
            serve.stop_after_writes(15, None)
            self.assertLess(ended[0] - t0, 0.29 + 0.25, "both locks share one STOP_WAIT")
        finally:
            serve.end_process, serve.STOP_WAIT = saved_end, saved_wait
            go.set()
            for t in threads:
                t.join(5)
            for held in (serve.NOTE_LOCK, serve.BACKUP_LOCK):
                if held.locked():
                    held.release()

    def test_marginalia_stop_during_a_send_leaves_no_temp_file_in_the_vault(self):
        vault = os.path.join(self.tmp, "Stop Vault")
        os.makedirs(os.path.join(vault, ".obsidian"))
        with open(os.path.join(vault, ".obsidian", "app.json"), "w", encoding="utf-8") as f:
            json.dump({"attachmentFolderPath": "Attachments"}, f)
        config = os.path.join(self.tmp, "obsidian.json")
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {"s1": {"path": vault, "open": True}}}, f)
        image = os.urandom(12 * 1024 * 1024)
        with self.fake_home():
            p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP, "--obsidian-config",
                                  config, "--backup-dir", os.path.join(self.tmp, "backups")],
                                 env={"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "")},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                first, about = p.stdout.readline(), p.stdout.readline()
                if not first.startswith("Marginalia: http://127.0.0.1:"):
                    p.kill()
                    self.fail(first + about + p.communicate()[1])
                port = int(first.split("127.0.0.1:", 1)[1].split("/", 1)[0])
                self.assertEqual(about.strip(), "Obsidian: vaults from %s: Stop Vault" % config)
                body = json.dumps({"vault": "Stop Vault", "file": "Notes/Stop.md", "title": "Stop", "blockId": "p_1",
                                   "markdown": linked("p_1", "x"), "images": [{"name": "marginalia-big.png",
                                   "data": base64.b64encode(image).decode("ascii")}]}).encode("utf-8")
                done = []

                def send():
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                        conn.request("POST", "/api/obsidian/note", body=body, headers={
                            "Host": "127.0.0.1:%d" % port, "Origin": "http://127.0.0.1:%d" % port, "X-Marginalia": "1",
                            "Content-Type": "application/json"})
                        conn.getresponse().read()
                    except (OSError, http.client.HTTPException):
                        pass                          # the server ended before it answered
                    done.append(True)
                t = threading.Thread(target=send)
                t.start()
                attachments = os.path.join(vault, "Attachments")
                deadline = time.monotonic() + 20
                while not done and time.monotonic() < deadline:       # SIGTERM the moment the image's temp file shows
                    if os.path.isdir(attachments) and any(n.endswith(".tmp") for n in os.listdir(attachments)):
                        break
                    time.sleep(0.0005)
                p.send_signal(15)                                      # what `marginalia stop` sends
                p.wait(10)
                t.join(30)
            finally:
                if p.poll() is None:
                    p.kill()
                p.communicate()
        self.assertEqual(p.returncode, -15)
        left = [os.path.join(d, n) for d, _, files in os.walk(vault) for n in files if n.endswith(".tmp")]
        self.assertEqual(left, [], "no partial temp file in the vault")
        img = os.path.join(vault, "Attachments", "marginalia-big.png")
        if os.path.exists(img):
            with open(img, "rb") as f:
                self.assertEqual(f.read(), image, "an image is never half-written")

    def test_marginalia_stop_during_a_pdf_upload_leaves_no_temp_file(self):
        backups = os.path.join(self.tmp, "backups")
        pdfs = os.path.join(backups, serve.PDF_FOLDER)
        pdf = b"%PDF-1.7\n" + os.urandom(12 * 1024 * 1024)
        with self.fake_home():
            p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP,
                                  "--obsidian-sandbox", os.path.join(self.tmp, "sandbox"), "--backup-dir", backups],
                                 env={"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "")},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            conn = None
            try:
                first = p.stdout.readline()
                if not first.startswith("Marginalia: http://127.0.0.1:"):
                    p.kill()
                    self.fail(first + p.communicate()[1])
                port = int(first.split("127.0.0.1:", 1)[1].split("/", 1)[0])
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                conn.putrequest("POST", serve.PDF_PATH, skip_host=True, skip_accept_encoding=True)
                for k, v in {"Host": "127.0.0.1:%d" % port, "Origin": "http://127.0.0.1:%d" % port, "X-Marginalia": "1",
                             "Content-Type": "application/pdf", "X-Marginalia-Name": "Stopped",
                             "X-Marginalia-Sha256": hashlib.sha256(pdf).hexdigest(),
                             "Content-Length": str(len(pdf))}.items():
                    conn.putheader(k, v)
                conn.endheaders()
                conn.send(pdf[:4 * 1024 * 1024])               # a part of the body: the rest never comes
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:            # SIGTERM once the temp file holds a part of it
                    temps = [n for n in os.listdir(pdfs) if n.endswith(".tmp")] if os.path.isdir(pdfs) else []
                    if temps and os.path.getsize(os.path.join(pdfs, temps[0])) > 0:
                        break
                    time.sleep(0.005)
                else:
                    self.fail("the upload never reached its temp file")
                p.send_signal(15)                             # what `marginalia stop` sends
                p.wait(10)
            finally:
                if conn is not None:
                    conn.close()
                if p.poll() is None:
                    p.kill()
                p.communicate()
        self.assertEqual(p.returncode, -15)
        self.assertEqual(os.listdir(pdfs), [], "no partial temp file in the PDFs folder")

    def test_a_named_config_that_lists_no_vault_stops_the_server(self):
        vault = os.path.join(self.tmp, "Test Vault")
        os.makedirs(vault)

        def put(name, text):
            path = os.path.join(self.tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            return path
        good = put("obsidian.json", json.dumps({"vaults": {"t1": {"path": vault, "open": True}}}))
        locked = put("locked.json", json.dumps({"vaults": {"t1": {"path": vault}}}))
        os.chmod(locked, 0)
        with self.fake_home():
            try:
                for label, path, why in [
                    ("a typo", os.path.join(self.tmp, "obsidain.json"), "there is no such file"),
                    ("a folder", self.tmp, "it is a folder"),
                    ("broken JSON", put("broken.json", "{"), "it is not JSON text"),
                    ("no vault list", put("empty.json", "{}"), 'no "vaults" list'),
                    ("vault folders missing", put("gone.json", json.dumps({"vaults": {"g": {"path": os.path.join(self.tmp, "Gone")}}})),
                     "none of the vault folders it names exists"),
                    ("unreadable", locked, "cannot be read"),
                ]:
                    if path == locked and os.access(locked, os.R_OK):
                        continue                                  # running as root: chmod 0 does not lock it
                    with self.subTest(label):
                        with self.assertRaises(ValueError) as cm:
                            serve.startup_config(serve.parse_args(["--obsidian-config", path]))
                        self.assertIn(why, str(cm.exception))
                        os.environ[serve.CONFIG_ENV] = path
                        try:
                            with self.assertRaises(ValueError) as cm:
                                serve.startup_config(serve.parse_args([]))
                            self.assertIn(serve.CONFIG_ENV, str(cm.exception))
                        finally:
                            os.environ.pop(serve.CONFIG_ENV, None)
            finally:
                os.chmod(locked, 0o600)
            self.assertEqual(serve.startup_config(serve.parse_args(["--obsidian-config", good])),
                             (good, "Obsidian: vaults from %s: Test Vault" % good))
            # Obsidian's own list may be empty (Obsidian not installed): the server starts, the page uses links
            os.remove(serve.default_config_path())
            config, line = serve.startup_config(serve.parse_args([]))
            self.assertIsNone(config)
            self.assertIn("obsidian:// links", line)
            code, out, err = self.run_cli("--obsidian-config", os.path.join(self.tmp, "obsidain.json"))
            self.assertEqual((code, out), (1, ""), err)
            self.assertIn("there is no such file", err)

    def test_sandbox_never_replaces_a_vault_list_it_did_not_write(self):
        def assert_refused(folder, config_text=None, note=""):
            config = os.path.join(folder, "obsidian.json")
            before = sorted(os.listdir(folder)) if os.path.isdir(folder) else None
            with self.assertRaises(ValueError, msg=note):
                serve.obsidian_config_of(serve.parse_args(["--obsidian-sandbox", folder]))
            if config_text is not None:
                with open(config, encoding="utf-8") as f:
                    self.assertEqual(f.read(), config_text, note)
            self.assertEqual(sorted(os.listdir(folder)) if os.path.isdir(folder) else None, before, note + ": nothing new")
        with self.fake_home() as decoy:
            obsidian = os.path.dirname(serve.default_config_path())
            with open(serve.default_config_path(), encoding="utf-8") as f:
                registry = f.read()
            assert_refused(obsidian, registry, "Obsidian's own settings folder")
            assert_refused(obsidian + os.sep, registry, "the same, with a trailing slash")
            os.makedirs(os.path.join(obsidian, "Partitions"))
            assert_refused(os.path.join(obsidian, "Partitions"), None, "a folder inside it")
            os.symlink(obsidian, os.path.join(self.tmp, "link-to-obsidian"))
            assert_refused(os.path.join(self.tmp, "link-to-obsidian"), registry, "a symlink to it")
            upper = os.path.join(os.path.dirname(obsidian), "Obsidian")
            if os.path.exists(upper):                         # a case-insensitive disk (macOS's default)
                assert_refused(upper, registry, "the same folder in other letters")
            # a folder with a vault list of its own: Obsidian-shaped, a hand-made test list, a symlink, a folder
            def put(path, text):
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
            for label, make in [
                ("Obsidian-shaped", lambda c: put(c, registry)),
                ("a test list", lambda c: put(c, json.dumps({"vaults": {"t1": {"path": decoy}}}))),
                ("two entries", lambda c: put(c, json.dumps({"vaults": {
                    serve.SANDBOX_ID: {"path": os.path.join(os.path.dirname(c), serve.SANDBOX_VAULT)}, "t1": {"path": decoy}}}))),
                ("broken JSON", lambda c: put(c, "{")),
                ("a symlink", lambda c: os.symlink(serve.default_config_path(), c)),
                ("a folder", lambda c: os.makedirs(c)),
            ]:
                with self.subTest(label):
                    folder = os.path.join(self.tmp, "own-" + label.replace(" ", "-"))
                    os.makedirs(folder)
                    make(os.path.join(folder, "obsidian.json"))
                    text = None
                    if os.path.isfile(os.path.join(folder, "obsidian.json")):
                        with open(os.path.join(folder, "obsidian.json"), encoding="utf-8") as f:
                            text = f.read()
                    assert_refused(folder, text, label)
            with open(serve.default_config_path(), encoding="utf-8") as f:
                self.assertEqual(f.read(), registry, "Obsidian's own list is unchanged")
            self.assertEqual(os.listdir(decoy), [".obsidian"])

    def test_the_backup_folder_comes_from_the_option_the_variable_or_documents(self):
        with self.fake_home():
            home = os.environ["HOME"]
            default = os.path.join(home, "Documents", "Marginalia Backups")
            self.assertEqual(serve.default_backup_dir(), default)
            os.environ.pop(serve.BACKUP_ENV, None)
            try:
                self.assertEqual(serve.startup_backup(serve.parse_args([]), APP),
                                 (default, "Backups: once a day into %s (the newest 30 are kept)" % default))
                option, variable = os.path.join(self.tmp, "Option"), os.path.join(self.tmp, "Variable")
                os.environ[serve.BACKUP_ENV] = variable
                self.assertEqual(serve.startup_backup(serve.parse_args([]), APP)[0], variable)
                self.assertEqual(serve.startup_backup(serve.parse_args(["--backup-dir", option]), APP)[0], option,
                                 "the option wins over the variable")
                self.assertEqual(serve.startup_backup(serve.parse_args(["--backup-dir=" + option + "/"]), APP)[0], option)
                for env, argv, why in [
                    (variable, ["--backup-dir", ""], "--backup-dir needs a folder"),
                    (variable, ["--backup-dir", "  "], "--backup-dir needs a folder"),
                    (variable, ["--backup-dir", "Backups"], "--backup-dir: Backups is not an absolute path"),
                    (variable, ["--backup-dir", os.path.join(APP, "backups")], "inside the app folder"),
                    ("", [], serve.BACKUP_ENV + " is set but empty"),
                    (" ", [], serve.BACKUP_ENV + " is set but empty"),
                    ("~/Backups", [], serve.BACKUP_ENV + ": ~/Backups is not an absolute path"),
                    (os.path.join(APP, "test", "b"), [], "inside the app folder"),
                ]:
                    with self.subTest(env=env, argv=argv):
                        os.environ[serve.BACKUP_ENV] = env
                        with self.assertRaises(ValueError) as cm:
                            serve.startup_backup(serve.parse_args(argv), APP)
                        self.assertIn(why, str(cm.exception))
            finally:
                os.environ.pop(serve.BACKUP_ENV, None)
            # the default inside the served folder (HOME pointing at it) is refused like any other
            os.environ["HOME"] = os.path.join(APP, "test")
            try:
                with self.assertRaises(ValueError) as cm:
                    serve.startup_backup(serve.parse_args([]), APP)
                self.assertIn("the default backup folder", str(cm.exception))
            finally:
                os.environ["HOME"] = home
            self.assertFalse(os.path.exists(default), "nothing is made at start")
            self.assertFalse(os.path.exists(os.path.join(home, "Documents")))

    def test_a_bad_backup_folder_stops_the_server(self):
        with self.fake_home() as decoy:
            for argv, env, why in [
                (["--backup-dir", ""], {}, "Backups: --backup-dir needs a folder"),
                (["--backup-dir=relative/folder"], {}, "relative/folder is not an absolute path"),
                (["--backup-dir", os.path.join(APP, "backups")], {}, "inside the app folder"),
                (["--backup-dir", APP], {}, "inside the app folder"),
                ([], {serve.BACKUP_ENV: ""}, "Backups: %s is set but empty" % serve.BACKUP_ENV),
                ([], {serve.BACKUP_ENV: "Backups"}, "Backups is not an absolute path"),
                ([], {serve.BACKUP_ENV: os.path.join(APP, "docs", "b")}, "inside the app folder"),
            ]:
                with self.subTest(argv=argv, env=env):
                    code, out, err = self.run_cli(*argv, env=env)
                    self.assertEqual((code, out), (1, ""), err)
                    self.assertIn(why, err)
            self.assertFalse(os.path.exists(os.path.join(APP, "backups")))
            self.assertFalse(os.path.exists(os.path.join(APP, "docs", "b")))
            self.assertFalse(os.path.exists(os.path.join(os.environ["HOME"], "Documents")))
            self.assertEqual(os.listdir(decoy), [".obsidian"])

    def test_the_server_names_its_backup_folder_and_makes_nothing_at_start(self):
        sandbox = ["--obsidian-sandbox", os.path.join(self.tmp, "sandbox")]
        vault = os.path.join(self.tmp, "Config Vault")
        os.makedirs(vault)
        config = os.path.join(self.tmp, "config.json")
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {"c1": {"path": vault, "open": True}}}, f)
        with self.fake_home():
            real = os.path.join(os.environ["HOME"], "Documents", "Marginalia Backups")    # the (fake) user's folder
            for argv, env, folder in [
                (sandbox + ["--backup-dir", os.path.join(self.tmp, "Option Backups")], {},
                 os.path.join(self.tmp, "Option Backups")),
                (sandbox, {serve.BACKUP_ENV: os.path.join(self.tmp, "Env Backups")}, os.path.join(self.tmp, "Env Backups")),
                (sandbox, {}, os.path.join(self.tmp, "sandbox", "Backups")),     # a test server: beside its vault
                (["--obsidian-config", config], {}, os.path.join(self.tmp, "Backups")),   # beside its own vault list
                ([], {serve.CONFIG_ENV: config}, os.path.join(self.tmp, "Backups")),
                (["--obsidian-config", config, "--backup-dir", os.path.join(self.tmp, "Option Backups")], {},
                 os.path.join(self.tmp, "Option Backups")),
                (["--obsidian-config", serve.default_config_path()], {}, real),     # Obsidian's own list, named
                ([], {}, real),                                                       # the user's own server
            ]:
                with self.subTest(argv=argv, env=env):
                    e = {"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "")}
                    e.update(env)
                    p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP] + argv,
                                         env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        lines = [p.stdout.readline() for _ in range(3)]
                        if not lines[0].startswith("Marginalia: http://127.0.0.1:"):
                            p.kill()
                            self.fail("".join(lines) + p.communicate()[1])
                        port = int(lines[0].split("127.0.0.1:", 1)[1].split("/", 1)[0])
                        self.assertTrue(lines[1].startswith("Obsidian: vaults from "), lines)
                        self.assertEqual(lines[2].strip(), "Backups: once a day into %s (the newest 30 are kept)" % folder)
                        status, _, payload, _ = http_request(port, "GET", "/api/backup")
                        self.assertEqual((status, payload["dir"], payload["files"]),
                                         (200, serve.display_path(folder), []), payload)
                        self.assertFalse(os.path.exists(folder), "made by the first backup, not at start")
                    finally:
                        p.terminate()
                        try:
                            p.communicate(timeout=10)
                        except subprocess.TimeoutExpired:
                            p.kill()
                            p.communicate()

    def test_a_sandbox_server_keeps_its_backups_in_the_sandbox(self):
        # the test server CLAUDE.md describes: --obsidian-sandbox and nothing about backups. Its page backed up into
        # ~/Documents/Marginalia Backups: the test library took the day's name there (the user's own backup of the day
        # was then skipped), its "Back up now" replaced the user's file of the day, and its files counted toward the
        # 30 kept. Now its backups go beside its vault, and only --backup-dir or the variable moves them.
        sandbox = os.path.join(self.tmp, "obsidian-sandbox")
        with self.fake_home():
            os.environ.pop(serve.BACKUP_ENV, None)
            home = os.environ["HOME"]
            folder = os.path.join(sandbox, serve.SANDBOX_BACKUPS)
            self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-sandbox", sandbox]), APP),
                             (folder, "Backups: once a day into %s (the newest 30 are kept)" % folder))
            cwd = os.getcwd()
            os.chdir(self.tmp)
            try:                                     # a relative sandbox: the whole path of the folder it names
                self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-sandbox", "obsidian-sandbox"]),
                                                      APP)[0], folder)
            finally:
                os.chdir(cwd)
            option = os.path.join(self.tmp, "Option")
            self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-sandbox", sandbox, "--backup-dir",
                                                                    option]), APP)[0], option)
            os.environ[serve.BACKUP_ENV] = os.path.join(self.tmp, "Variable")
            try:
                self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-sandbox", sandbox]), APP)[0],
                                 os.path.join(self.tmp, "Variable"))
            finally:
                os.environ.pop(serve.BACKUP_ENV, None)
            # a blank sandbox is refused by startup_config; a sandbox inside the app folder by its backup folder (an
            # app folder of its own here, so that a mistake could not write into the real one)
            self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-sandbox", " "]), APP)[0],
                             serve.default_backup_dir())
            app = os.path.join(self.tmp, "app")
            os.makedirs(app)
            with open(os.path.join(app, "index.html"), "w", encoding="utf-8") as f:
                f.write("<!-- an app folder -->")
            with self.assertRaises(ValueError) as cm:
                serve.startup_backup(serve.parse_args(["--obsidian-sandbox", os.path.join(app, "sandbox")]), app)
            self.assertIn("--obsidian-sandbox's backup folder", str(cm.exception))
            self.assertIn("inside the app folder", str(cm.exception))
            code, out, err = self.run_cli("--dir", app, "--obsidian-sandbox", os.path.join(app, "sandbox"),
                                          env={serve.BACKUP_ENV: None})
            self.assertEqual((code, out), (1, ""), err)
            self.assertIn("Backups: --obsidian-sandbox's backup folder", err)
            self.assertEqual(os.listdir(app), ["index.html"], "a refused start makes no sandbox")
            # the server itself, started as CLAUDE.md says (port 0 here), with a page that backs up
            p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP,
                                  "--obsidian-sandbox", sandbox],
                                 env={"HOME": home, "PATH": os.environ.get("PATH", "")},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                lines = [p.stdout.readline() for _ in range(3)]
                if not lines[0].startswith("Marginalia: http://127.0.0.1:") or folder not in lines[2]:
                    p.kill()
                    self.fail("".join(lines) + p.communicate()[1])
                port = int(lines[0].split("127.0.0.1:", 1)[1].split("/", 1)[0])
                self.assertEqual(lines[2].strip(), "Backups: once a day into %s (the newest 30 are kept)" % folder)
                text = BackupApiTest.backup_text()
                for mode in ("auto", "manual"):                  # the first of the day, then "Back up now"
                    body = ('{"mode":"%s","backup":' % mode + text + "}").encode("utf-8")
                    status, _, payload, _ = http_request(port, "POST", "/api/backup", body, post_headers(port))
                    self.assertEqual((status, payload["skipped"]), (200, False), payload)
                status, _, payload, _ = http_request(port, "GET", "/api/backup")
                self.assertEqual((status, payload["dir"], len(payload["files"])),
                                 (200, serve.display_path(folder), 1), payload)
            finally:
                p.terminate()
                try:
                    p.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.communicate()
            self.assertEqual(os.listdir(folder), [payload["files"][0]["name"]])
            self.assertFalse(os.path.exists(os.path.join(home, "Documents")), "nothing in the home's Documents")

    def test_a_server_with_a_vault_list_of_its_own_keeps_its_backups_beside_it(self):
        # B8: a server started with a vault list other than Obsidian's own (--obsidian-config, or
        # MARGINALIA_OBSIDIAN_CONFIG: a test's throwaway obsidian.json) and nothing about backups keeps its page's
        # backups in a Backups folder beside that list, as a sandbox does: in ~/Documents/Marginalia Backups a test
        # library's backup could become the day's file, and the user's own automatic backup would skip that day. The
        # user's own server (no option, or one that names Obsidian's own list) keeps the user's folder.
        lists = os.path.join(self.tmp, "lists")
        vault = os.path.join(self.tmp, "List Vault")
        os.makedirs(lists)
        os.makedirs(vault)
        config = os.path.join(lists, "obsidian.json")
        with open(config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {"l1": {"path": vault, "open": True}}}, f)
        beside = os.path.join(lists, serve.SANDBOX_BACKUPS)
        line = "Backups: once a day into %s (the newest 30 are kept)"

        def folder_of(argv, config_env=None, backup_env=None):
            saved = {k: os.environ.get(k) for k in (serve.CONFIG_ENV, serve.BACKUP_ENV)}
            for k, v in ((serve.CONFIG_ENV, config_env), (serve.BACKUP_ENV, backup_env)):
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            try:
                return serve.startup_backup(serve.parse_args(argv), APP)[0]
            finally:
                for k, v in saved.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
        with self.fake_home():
            os.environ.pop(serve.BACKUP_ENV, None)
            home = os.environ["HOME"]
            real = os.path.join(home, "Documents", "Marginalia Backups")         # the (fake) user's folder
            own = serve.default_config_path()                                     # the (fake) Obsidian's own list
            other = os.path.join(self.tmp, "other", "obsidian.json")
            option, variable = os.path.join(self.tmp, "Option"), os.path.join(self.tmp, "Variable")
            self.assertEqual(serve.startup_backup(serve.parse_args(["--obsidian-config", config]), APP),
                             (beside, line % beside))
            for label, argv, config_env, backup_env, folder in [
                ("the option", ["--obsidian-config", config], None, None, beside),
                ("the variable", [], config, None, beside),
                ("the option wins over the variable", ["--obsidian-config", other], config, None,
                 os.path.join(self.tmp, "other", "Backups")),
                ("a sandbox wins over the variable", ["--obsidian-sandbox", os.path.join(self.tmp, "sb")], config, None,
                 os.path.join(self.tmp, "sb", "Backups")),
                ("--backup-dir wins", ["--obsidian-config", config, "--backup-dir", option], None, None, option),
                ("--backup-dir wins over the variable's list", ["--backup-dir", option], config, None, option),
                ("MARGINALIA_BACKUP_DIR wins", ["--obsidian-config", config], None, variable, variable),
                ("MARGINALIA_BACKUP_DIR wins with the variable", [], config, variable, variable),
                ("no option: the user's own server", [], None, None, real),
                ("Obsidian's own list, named", ["--obsidian-config", own], None, None, real),
                ("Obsidian's own list in the variable", [], own, None, real),
                ("Obsidian's own list through ..", ["--obsidian-config", os.path.join(os.path.dirname(own), "..",
                                                                                     "obsidian", "obsidian.json")],
                 None, None, real),
                ("Obsidian's own list, the option over another variable", ["--obsidian-config", own], config, None,
                 real),
                ("a blank option is left to startup_config", ["--obsidian-config", " "], None, None, real),
                ("a blank variable is left to startup_config", [], " ", None, real),
            ]:
                with self.subTest(label):
                    self.assertEqual(folder_of(argv, config_env, backup_env), folder)
            link = os.path.join(self.tmp, "link to own.json")
            os.symlink(own, link)
            self.assertEqual(folder_of(["--obsidian-config", link]), real, "a symlink to Obsidian's own list is it")
            upper = os.path.join(os.path.dirname(own), "OBSIDIAN.JSON")
            if os.path.exists(upper):                                    # a disk that ignores letter case (macOS's)
                self.assertEqual(folder_of(["--obsidian-config", upper]), real, "the same file in other letters")
                self.assertTrue(serve.is_obsidians_own_list(upper.upper()))
            cwd = os.getcwd()
            os.chdir(lists)
            try:                                         # a relative path: the whole path of the folder it names
                self.assertEqual(folder_of(["--obsidian-config", "obsidian.json"]), beside)
                self.assertEqual(folder_of([], "obsidian.json"), beside)
            finally:
                os.chdir(cwd)
            # a list kept inside Obsidian's own settings folder: never a folder there, and not the user's either
            for path in (os.path.join(os.path.dirname(own), "test.json"),
                         os.path.join(os.path.dirname(own), "sub", "obsidian.json")):
                for argv, config_env, source in [(["--obsidian-config", path], None, "--obsidian-config"),
                                                 ([], path, serve.CONFIG_ENV)]:
                    with self.subTest(path=path, source=source):
                        with self.assertRaises(ValueError) as cm:
                            folder_of(argv, config_env)
                        self.assertIn("%s's backup folder" % source, str(cm.exception))
                        self.assertIn("Obsidian's own settings folder", str(cm.exception))
            linked_lists = os.path.join(self.tmp, "linked lists")         # its Backups a symlink into that folder
            os.makedirs(linked_lists)
            os.symlink(os.path.join(os.path.dirname(own), "sub"), os.path.join(linked_lists, serve.SANDBOX_BACKUPS))
            with self.assertRaises(ValueError) as cm:
                folder_of(["--obsidian-config", os.path.join(linked_lists, "obsidian.json")])
            self.assertIn("Obsidian's own settings folder", str(cm.exception))
            self.assertEqual(sorted(os.listdir(os.path.dirname(own))), ["obsidian.json"])
            # a list inside the app folder: refused like a sandbox there (an app folder of its own here)
            app = os.path.join(self.tmp, "app")
            os.makedirs(app)
            with open(os.path.join(app, "index.html"), "w", encoding="utf-8") as f:
                f.write("<!-- an app folder -->")
            inside_app = os.path.join(app, "t", "obsidian.json")
            with self.assertRaises(ValueError) as cm:
                serve.startup_backup(serve.parse_args(["--obsidian-config", inside_app]), app)
            self.assertIn("--obsidian-config's backup folder", str(cm.exception))
            self.assertIn("inside the app folder", str(cm.exception))
            code, out, err = self.run_cli("--dir", app, "--obsidian-config", inside_app, env={serve.BACKUP_ENV: None})
            self.assertEqual((code, out), (1, ""), err)
            self.assertIn("Backups: --obsidian-config's backup folder", err)
            self.assertEqual(os.listdir(app), ["index.html"])
            # Obsidian's own list, without its file (Obsidian not installed), in other letters, is still it
            os.environ["HOME"] = os.path.join(self.tmp, "bare home")
            try:
                bare = serve.default_config_path()
                self.assertTrue(serve.is_obsidians_own_list(bare))
                self.assertTrue(serve.is_obsidians_own_list(bare.replace("obsidian", "Obsidian")))
                self.assertFalse(serve.is_obsidians_own_list(config))
            finally:
                os.environ["HOME"] = home
            self.assertFalse(os.path.exists(beside), "nothing is made at start")
            self.assertFalse(os.path.exists(os.path.join(home, "Documents")))
            # the server itself, started with the list and nothing about backups, with a page that backs up
            for argv, env in [(["--obsidian-config", config], {}), ([], {serve.CONFIG_ENV: config})]:
                with self.subTest(argv=argv, env=env):
                    e = {"HOME": home, "PATH": os.environ.get("PATH", "")}
                    e.update(env)
                    p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--dir", APP] + argv,
                                         env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        lines = [p.stdout.readline() for _ in range(3)]
                        if not lines[0].startswith("Marginalia: http://127.0.0.1:") or beside not in lines[2]:
                            p.kill()
                            self.fail("".join(lines) + p.communicate()[1])
                        port = int(lines[0].split("127.0.0.1:", 1)[1].split("/", 1)[0])
                        self.assertEqual(lines[1].strip(), "Obsidian: vaults from %s: List Vault" % config)
                        self.assertEqual(lines[2].strip(), line % beside)
                        body = ('{"mode":"auto","backup":' + BackupApiTest.backup_text() + "}").encode("utf-8")
                        status, _, payload, _ = http_request(port, "POST", "/api/backup", body, post_headers(port))
                        self.assertEqual(status, 200, payload)
                        status, _, listing, _ = http_request(port, "GET", "/api/backup")
                        self.assertEqual((status, listing["dir"], [f["name"] for f in listing["files"]]),
                                         (200, serve.display_path(beside), [payload["file"]]), listing)
                    finally:
                        p.terminate()
                        try:
                            p.communicate(timeout=10)
                        except subprocess.TimeoutExpired:
                            p.kill()
                            p.communicate()
                    self.assertEqual(os.listdir(beside), [payload["file"]])
            self.assertFalse(os.path.exists(os.path.join(home, "Documents")), "nothing in the home's Documents")
            self.assertEqual(os.listdir(vault), [], "the vault is untouched")

    def test_sandbox_refuses_a_folder_inside_a_vault_or_a_symlinked_vault(self):
        vault = os.path.join(self.tmp, "Some Vault")
        os.makedirs(os.path.join(vault, ".obsidian"))
        with self.assertRaises(ValueError):
            serve.make_sandbox(os.path.join(vault, "tests"))
        self.assertFalse(os.path.exists(os.path.join(vault, "tests")), "nothing was created inside the vault")
        folder = os.path.join(self.tmp, "sb")
        os.makedirs(folder)
        os.symlink(vault, os.path.join(folder, serve.SANDBOX_VAULT))
        with self.assertRaises(ValueError):
            serve.make_sandbox(folder)
        self.assertFalse(os.path.exists(os.path.join(folder, "obsidian.json")))

    def test_the_app_flag_takes_only_a_version_and_the_apps_server_says_so(self):
        # FEATURES E2.1 a: only the desktop app passes --app <its version>; anything but digits.digits.digits stops the
        # server at start with exit 2 (argparse), before anything is made (not even a sandbox)
        with self.fake_home():
            sandbox = os.path.join(self.tmp, "sandbox")
            backups = os.path.join(self.tmp, "app-backups")
            for argv in (["--app", ""], ["--app="], ["--app", "1.0"], ["--app", "x.y.z"], ["--app", "1.0.0.0"],
                         ["--app", "v1.0.0"], ["--app", " 1.0.0"], ["--app", "١.٠.٠"], ["--app"]):
                with self.subTest(argv=argv):
                    code, out, err = self.run_cli("--obsidian-sandbox", sandbox, "--backup-dir", backups, *argv)
                    self.assertEqual((code, out), (2, ""), err)
                    self.assertIn("argument --app", err)
                    self.assertFalse(os.path.exists(sandbox), "a refused start makes no sandbox")
                    self.assertFalse(os.path.exists(backups))
            # the app's server itself, started as the app starts its copy (port 0 here), names the app in a 4th line
            p = subprocess.Popen([sys.executable, "-I", "-B", SERVE_PY, "--port", "0", "--bind", "127.0.0.1", "--dir",
                                  APP, "--obsidian-sandbox", sandbox, "--backup-dir", backups, "--app", "1.0.0"],
                                 env={"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "")},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                lines = [p.stdout.readline() for _ in range(4)]
                if not lines[0].startswith("Marginalia: http://127.0.0.1:"):
                    p.kill()
                    self.fail("".join(lines) + p.communicate()[1])
                port = int(lines[0].split("127.0.0.1:", 1)[1].split("/", 1)[0])
                self.assertEqual(lines[2].strip(), "Backups: once a day into %s (the newest 30 are kept)" % backups)
                self.assertEqual(lines[3].strip(), "App: the server of the Marginalia app 1.0.0; only the app's page "
                                                   "writes (X-Marginalia-Client)")
                status, _, payload, _ = http_request(port, "GET", serve.APP_PATH)
                self.assertEqual((status, payload), (200, {"ok": True, "app": True, "version": "1.0.0"}))
                body = ('{"mode":"manual","backup":' + BackupApiTest.backup_text() + "}").encode("utf-8")
                status, _, payload, _ = http_request(port, "POST", serve.BACKUP_PATH, body, post_headers(port))
                self.assertEqual((status, payload), (409, APP_ONLY_ANSWER))
                self.assertFalse(os.path.exists(backups), "nothing was written")
                h = dict(post_headers(port), **{serve.CLIENT_HEADER: serve.APP_CLIENT})
                status, _, payload, _ = http_request(port, "POST", serve.BACKUP_PATH, body, h)
                self.assertEqual((status, payload["skipped"]), (200, False), payload)
                status, headers, _, raw = http_request(port, "GET", serve.LATEST_PATH)
                self.assertEqual((status, headers.get("x-marginalia-backup-name")), (200, payload["file"]))
                self.assertEqual(raw, BackupApiTest.backup_text().encode("utf-8"))
            finally:
                p.terminate()
                try:
                    p.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.communicate()
            self.assertFalse(os.path.exists(os.path.join(os.environ["HOME"], "Documents")), "nothing in Documents")


# ---- FEATURES E2.1: the desktop app's server (--app) and GET /api/backup/latest -----------------------------------------

APP_ONLY_ANSWER = {"ok": False, "error": "app_only",
                   "message": "Marginalia is now an app. Open the Marginalia app to do this."}


def serve_in_thread(**kwargs):
    """make_server(APP, "127.0.0.1", 0, quiet=True, **kwargs), answering in a daemon thread -> (httpd, thread)."""
    httpd = serve.make_server(APP, "127.0.0.1", 0, quiet=True, **kwargs)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    return httpd, thread


def stop_in_thread(httpd, thread):
    httpd.shutdown()
    httpd.server_close()
    thread.join(5)


def announce(port, path, headers, length, timeout=5):
    """A POST that announces `length` bytes and sends none -> (status, JSON). A server that waited for the body would
    keep the answer back, and the socket timeout would fail the test."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.putrequest("POST", path, skip_host=True, skip_accept_encoding=True)
    for k, v in dict(headers, Host="127.0.0.1:%d" % port, **{"Content-Length": str(length)}).items():
        conn.putheader(k, v)
    conn.endheaders()
    r = conn.getresponse()
    raw = r.read()
    conn.close()
    return r.status, (json.loads(raw.decode("utf-8")) if raw else None)


class AppServerTest(unittest.TestCase):
    """FEATURES E2.1 a-c and e: the desktop app's server (--app VERSION, make_server(app_version=...)) beside a server
    made without the flag, both on the real handler in threads with one throwaway vault (their own obsidian.json) and a
    throwaway backup folder each, in a fresh temp folder. GET /api/app answers only with the flag (else 404, exactly as
    an unknown route); with it, every POST route needs X-Marginalia-Client: app (the two backup routes also take
    browser-move), checked after the other guards and before the body is read, and anything else gets the 409
    "app_only" with nothing written; without it the header changes nothing. serve.today() is replaced."""

    VERSION = "1.2.3"
    ROUTES = (serve.NOTE_PATH, serve.NOTES_PATH, serve.BACKUP_PATH, serve.PDF_PATH)
    LIMITS = {serve.NOTE_PATH: serve.MAX_BODY, serve.NOTES_PATH: serve.MAX_NOTES_BODY,
              serve.BACKUP_PATH: serve.MAX_BACKUP_BODY, serve.PDF_PATH: serve.MAX_PDF_BODY}

    @classmethod
    def setUpClass(cls):
        cls.base = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-app-test-"))
        cls.vault = os.path.join(cls.base, "App Vault")
        os.makedirs(os.path.join(cls.vault, ".obsidian"))
        cls.config = os.path.join(cls.base, "obsidian.json")
        with open(cls.config, "w", encoding="utf-8") as f:
            json.dump({"vaults": {"v1": {"path": cls.vault, "ts": 1, "open": True}}}, f)
        cls.folder = os.path.join(cls.base, "App Backups")              # throwaway backup folders, never the real one
        cls.plain_folder = os.path.join(cls.base, "Plain Backups")
        for folder in (cls.folder, cls.plain_folder):
            assert os.path.realpath(folder) != os.path.realpath(serve.default_backup_dir())
        cls.app, cls.app_thread = serve_in_thread(obsidian_config=cls.config, backup_dir=cls.folder,
                                                  app_version=cls.VERSION)
        cls.plain, cls.plain_thread = serve_in_thread(obsidian_config=cls.config, backup_dir=cls.plain_folder)
        cls.app_port, cls.plain_port = cls.app.server_address[1], cls.plain.server_address[1]

    @classmethod
    def tearDownClass(cls):
        stop_in_thread(cls.app, cls.app_thread)
        stop_in_thread(cls.plain, cls.plain_thread)
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.saved_today = serve.today
        serve.today = lambda: "2026-11-11"
        self.clean()

    def tearDown(self):
        serve.today = self.saved_today
        self.clean()

    # ---- helpers

    def clean(self):
        """The vault back to its .obsidian folder alone, and no backup folder."""
        for name in os.listdir(self.vault):
            p = os.path.join(self.vault, name)
            if name == ".obsidian":
                continue
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        for folder in (self.folder, self.plain_folder):
            shutil.rmtree(folder, ignore_errors=True)

    def written(self):
        """Every folder and file the routes could have made: in the vault (but .obsidian) and both backup folders."""
        out = [os.path.basename(f) for f in (self.folder, self.plain_folder) if os.path.lexists(f)]
        for top in (self.vault, self.folder, self.plain_folder):
            for d, dirs, files in os.walk(top):
                dirs[:] = [x for x in dirs if not (d == self.vault and x == ".obsidian")]
                out += [os.path.relpath(os.path.join(d, x), self.base) for x in dirs + files]
        return sorted(out)

    def request_for(self, path, port):
        """A valid POST to `path` on `port`, as the page sends it, without X-Marginalia-Client -> (body, headers)."""
        if path == serve.PDF_PATH:
            data = pdf_body("app test")
            return data, {"Origin": "http://127.0.0.1:%d" % port, "X-Marginalia": "1",
                          "Content-Type": "application/pdf", "X-Marginalia-Sha256": sha_of(data),
                          "X-Marginalia-Name": urllib.parse.quote("App Book")}
        if path == serve.BACKUP_PATH:
            body = '{"mode":"manual","backup":' + BackupApiTest.backup_text("app") + "}"
        elif path == serve.NOTE_PATH:
            body = json.dumps({"vault": "App Vault", "file": "Notes/Book.md", "title": "Book", "blockId": "p_1",
                               "markdown": linked("p_1", "one")})
        else:
            body = json.dumps({"vault": "App Vault", "file": "Notes/All.md", "title": "All",
                               "blocks": [{"blockId": "p_2", "markdown": linked("p_2", "two")}]})
        return body.encode("utf-8"), post_headers(port)

    def post(self, port, path, client=None, headers=None):
        """POST a valid request to `path` with X-Marginalia-Client: `client` (None: no such header); `headers` adds
        or replaces some (None leaves one out) -> (status, headers, JSON, raw)."""
        body, h = self.request_for(path, port)
        if client is not None:
            h[serve.CLIENT_HEADER] = client
        h.update(headers or {})
        return http_request(port, "POST", path, body, {k: v for k, v in h.items() if v is not None})

    # ---- GET /api/app

    def test_get_api_app_answers_only_on_the_apps_server(self):
        status, headers, payload, _ = http_request(self.app_port, "GET", serve.APP_PATH)
        self.assertEqual((status, payload), (200, {"ok": True, "app": True, "version": self.VERSION}))
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertTrue(headers.get("content-type", "").startswith("application/json"), headers)
        self.assertFalse([k for k in headers if k.startswith("access-control-")], "no CORS")
        self.assertEqual(http_request(self.app_port, "GET", serve.APP_PATH + "?v=2")[2]["version"], self.VERSION)
        status, _, payload, _ = http_request(self.app_port, "GET", serve.APP_PATH,
                                             headers={"Host": "localhost:%d" % self.app_port})
        self.assertEqual((status, payload["app"]), (200, True))
        for path in (serve.APP_PATH + "/", serve.APP_PATH + "s", "/api/App", serve.APP_PATH + "/version"):
            status, _, payload, _ = http_request(self.app_port, "GET", path)
            self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}), path)

        def answer(port, path):
            status, headers, payload, _ = http_request(port, "GET", path)
            return status, payload, {k: headers.get(k) for k in ("content-type", "content-length", "cache-control",
                                                                 "x-content-type-options")}
        # without the flag: exactly what an unknown route answers (and a serve.py from before the app)
        self.assertEqual(answer(self.plain_port, serve.APP_PATH), answer(self.plain_port, "/api/no-such-route"))
        self.assertEqual(answer(self.plain_port, serve.APP_PATH)[:2], (404, {"ok": False, "error": "not found"}))
        # the guards of every GET route
        for httpd, port in ((self.app, self.app_port), (self.plain, self.plain_port)):
            self.assertEqual(http_request(port, "HEAD", serve.APP_PATH)[0], 404, "HEAD: 404 as on every /api/ route")
            status, _, payload, _ = http_request(port, "GET", serve.APP_PATH,
                                                 headers={"Host": "rebind.example:%d" % port})
            self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden host"}))
            self.assertEqual(via_socket(httpd, ("192.168.1.20", 50000), "GET", serve.APP_PATH),
                             (403, {"ok": False, "error": "forbidden client"}))
        self.assertIsNone(serve.Handler.app_version, "a handler made elsewhere is no app's server")

    # ---- the write guard

    def test_with_the_flag_only_the_apps_page_writes_and_the_move_backs_up(self):
        refused = [None, "", "browser", "App", "APP", "apps", "app,browser-move", "app browser-move", "Browser-Move",
                   "browser-move2", "1"]
        for path in self.ROUTES:
            backup_route = path in (serve.BACKUP_PATH, serve.PDF_PATH)
            allowed = ["app", " app "] + (["browser-move"] if backup_route else [])
            for client in refused + ([] if backup_route else ["browser-move"]):
                with self.subTest(path=path, client=client):
                    status, headers, payload, _ = self.post(self.app_port, path, client)
                    self.assertEqual((status, payload), (409, APP_ONLY_ANSWER))
                    self.assertEqual(headers.get("cache-control"), "no-store")
                    self.assertEqual(headers.get("x-content-type-options"), "nosniff")
                    self.assertEqual(self.written(), [], "nothing was written, no folder made")
            for client in allowed:
                with self.subTest(path=path, client=client):
                    status, _, payload, _ = self.post(self.app_port, path, client)
                    self.assertEqual((status, payload["ok"]), (200, True), payload)
                    self.assertNotEqual(self.written(), [], "written")
                    self.clean()

    def test_the_app_guard_comes_after_the_other_guards_and_before_the_body(self):
        port = self.app_port
        for path in self.ROUTES:
            body, base = self.request_for(path, port)
            for label, change, status in [("another site", {"Origin": "https://evil.example"}, 403),
                                          ("no Origin", {"Origin": None}, 403),
                                          ("no X-Marginalia", {"X-Marginalia": None}, 403),
                                          ("DNS rebinding", {"Host": "rebind.example:%d" % port}, 403),
                                          ("a form post", {"Content-Type": "text/plain"}, 415)]:
                with self.subTest(path=path, label=label):
                    code, _, payload, _ = self.post(port, path, None, change)
                    self.assertEqual(code, status, payload)
                    self.assertNotEqual(payload.get("error"), "app_only")
            with self.subTest(path=path, label="too large"):
                self.assertEqual(announce(port, path, base, self.LIMITS[path] + 1)[0], 413)
            with self.subTest(path=path, label="before the body"):
                self.assertEqual(announce(port, path, base, len(body)), (409, APP_ONLY_ANSWER))
            self.assertEqual(self.written(), [], path)
        # the PDF route's own header checks come later: without the app's header it never gets that far
        status, _, payload, _ = self.post(port, serve.PDF_PATH, None, {"X-Marginalia-Sha256": "not a hash"})
        self.assertEqual((status, payload), (409, APP_ONLY_ANSWER))
        status, _, payload, _ = self.post(port, serve.PDF_PATH, "app", {"X-Marginalia-Sha256": "not a hash"})
        self.assertEqual(status, 400, payload)
        # a body that is no JSON: never read without the header; read (and refused) with it
        h = dict(post_headers(port), **{serve.CLIENT_HEADER: "browser-move"})
        for path in (serve.NOTE_PATH, serve.NOTES_PATH):
            self.assertEqual(http_request(port, "POST", path, b"{nope", h)[2], APP_ONLY_ANSWER, path)
        self.assertEqual(http_request(port, "POST", serve.BACKUP_PATH, b"{nope", h)[0], 400)
        # routes the server does not have stay 404
        self.assertEqual(self.post(port, "/api/no-such-route", "app")[0], 404)
        self.assertEqual(self.written(), [])
        bare, thread = serve_in_thread(obsidian_config=self.config, app_version=self.VERSION)   # no backup folder
        try:
            for path in (serve.BACKUP_PATH, serve.PDF_PATH):
                status, _, payload, _ = self.post(bare.server_address[1], path, "app")
                self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}), path)
            self.assertEqual(http_request(bare.server_address[1], "GET", serve.APP_PATH)[0], 200)
        finally:
            stop_in_thread(bare, thread)

    def test_without_the_flag_the_client_header_changes_nothing(self):
        for path in self.ROUTES:
            for client in (None, "browser", "app", "browser-move", ""):
                with self.subTest(path=path, client=client):
                    status, _, payload, _ = self.post(self.plain_port, path, client)
                    self.assertEqual((status, payload["ok"]), (200, True), payload)
                    self.assertNotEqual(self.written(), [])
                    self.clean()

    def test_get_routes_need_no_client_header(self):
        port = self.app_port
        status, _, payload, _ = http_request(port, "GET", serve.VAULTS_PATH)
        self.assertEqual((status, [v["name"] for v in payload["vaults"]]), (200, ["App Vault"]))
        self.assertEqual(http_request(port, "GET", serve.BACKUP_PATH)[2]["files"], [])
        self.assertEqual(http_request(port, "GET", serve.PDFS_PATH)[2]["files"], [])
        self.assertEqual(http_request(port, "GET", serve.LATEST_PATH)[:3:2], (404, {"ok": False, "error": "no_backup"}))
        self.assertEqual(self.post(port, serve.BACKUP_PATH, "app")[0], 200)
        status, headers, _, raw = http_request(port, "GET", serve.LATEST_PATH)
        self.assertEqual((status, headers.get("x-marginalia-backup-name")), (200, "marginalia-backup-2026-11-11.json"))
        self.assertEqual(raw, BackupApiTest.backup_text("app").encode("utf-8"))
        self.assertEqual(http_request(port, "GET", "/index.html")[0], 200, "the app's files are served as ever")

    def test_the_version_must_be_digits_dot_digits_dot_digits(self):
        for good in ("0.0.0", "1.0.0", "12.345.6789"):
            self.assertEqual(serve.check_app_version(good), good)
            self.assertEqual(serve.parse_args(["--app", good]).app, good)
        self.assertIsNone(serve.parse_args([]).app)
        for bad in ("", " ", "1", "1.0", "1.0.0.0", "1.0.0 ", " 1.0.0", "1.0.0\n", "v1.0.0", "1.0.x", "1..0", ".1.0",
                    "1.0.", "+1.0.0", "1,0,0", "١.٠.٠", "１.0.0", "1.0.0-beta"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    serve.check_app_version(bad)
                err = io.StringIO()
                with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(err):
                    serve.parse_args(["--app", bad])
                self.assertEqual(cm.exception.code, 2)
                self.assertIn("argument --app", err.getvalue())
                with self.assertRaises(ValueError):
                    serve.make_server(APP, "127.0.0.1", 0, quiet=True, app_version=bad)
        for bad in (1, 1.0, b"1.0.0", ["1.0.0"], ""):
            with self.assertRaises(ValueError):
                serve.make_server(APP, "127.0.0.1", 0, quiet=True, app_version=bad)
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            serve.parse_args(["--app"])
        self.assertEqual(cm.exception.code, 2)


class _Reads:
    """An open file that records the sizes read from it and, with shrink, truncates the file on disk to what the first
    read returned (a backup file cut short while it is being sent)."""

    def __init__(self, f, path, shrink=False):
        self.f, self.path, self.shrink, self.sizes = f, path, shrink, []

    def fileno(self):
        return self.f.fileno()

    def read(self, n=-1):
        self.sizes.append(n)
        data = self.f.read(n)
        if self.shrink and len(self.sizes) == 1:
            os.truncate(self.path, len(data))
        return data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.f.close()


class LatestBackupApiTest(unittest.TestCase):
    """FEATURES E2.1 d: GET /api/backup/latest on the real handler in threads, a plain server and an app's server
    (--app) sharing one throwaway backup folder, and a server without a backup folder: the newest kept backup (GET
    /api/backup's first file) byte for byte, never what GET /api/backup does not list (symlinks, folders, FIFOs, other
    names), never through a symlink put in its place, streamed in pieces; 404 "no_backup" when there is none; the
    Sec-Fetch-Site rule of GET /api/backup/pdf/<sha256>, loopback clients and the Host check."""

    NAME = "marginalia-backup-2026-11-11.json"
    NO_BACKUP = {"ok": False, "error": "no_backup"}

    @classmethod
    def setUpClass(cls):
        cls.base = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-latest-test-"))
        cls.folder = os.path.join(cls.base, "Marginalia Backups")
        assert os.path.realpath(cls.folder) != os.path.realpath(serve.default_backup_dir())
        config = os.path.join(cls.base, "no-obsidian.json")
        cls.httpd, cls.thread = serve_in_thread(backup_dir=cls.folder, obsidian_config=config)
        cls.app, cls.app_thread = serve_in_thread(backup_dir=cls.folder, obsidian_config=config, app_version="1.0.0")
        cls.bare, cls.bare_thread = serve_in_thread(obsidian_config=config)
        cls.port, cls.app_port, cls.bare_port = (s.server_address[1] for s in (cls.httpd, cls.app, cls.bare))

    @classmethod
    def tearDownClass(cls):
        for httpd, thread in ((cls.httpd, cls.thread), (cls.app, cls.app_thread), (cls.bare, cls.bare_thread)):
            stop_in_thread(httpd, thread)
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self):
        self.outside = os.path.realpath(tempfile.mkdtemp(prefix="outside-", dir=self.base))
        self.secret = os.path.join(self.outside, "secret.json")
        with open(self.secret, "wb") as f:
            f.write(b'{"format":"marginalia","version":1,"collections":[],"prompts":[],"secret":"OUTSIDE"}')
        self.saved = {k: getattr(serve, k) for k in ("backup_files", "open_regular", "today")}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(serve, k, v)
        shutil.rmtree(self.folder, ignore_errors=True)
        shutil.rmtree(self.outside, ignore_errors=True)

    # ---- helpers

    def put(self, name, data):
        os.makedirs(self.folder, exist_ok=True)
        with open(os.path.join(self.folder, name), "wb") as f:
            f.write(data)

    def decoys(self):
        """Entries named (almost) like newer backups that GET /api/backup never lists, so they are never sent."""
        os.makedirs(self.folder, exist_ok=True)
        os.symlink(self.secret, os.path.join(self.folder, "marginalia-backup-2099-01-01.json"))
        os.makedirs(os.path.join(self.folder, "marginalia-backup-2098-01-01.json"))
        os.mkfifo(os.path.join(self.folder, "marginalia-backup-2097-01-01.json"))
        for name in ("Marginalia-Backup-2096-01-01.json", "marginalia-backup-2095-01-01.json.tmp",
                     "marginalia-backup-2094-1-1.json", "marginalia-backup-٢٠٩٣-01-01.json",
                     ".marginalia-x.tmp", "marginalia-backup-2093-01-01.JSON"):
            self.put(name, b'{"decoy": "OUTSIDE"}')

    def latest(self, port=None, headers=None):
        return http_request(port or self.port, "GET", serve.LATEST_PATH, None, headers)

    # ---- tests

    def test_no_backup_is_a_404_and_a_get_makes_nothing(self):
        for port in (self.port, self.app_port, self.bare_port):
            status, headers, payload, _ = self.latest(port)
            self.assertEqual((status, payload), (404, self.NO_BACKUP), port)
            self.assertEqual(headers.get("cache-control"), "no-store")
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertNotIn("x-marginalia-backup-name", headers)
            self.assertEqual(http_request(port, "HEAD", serve.LATEST_PATH)[0], 404)
        self.assertFalse(os.path.exists(self.folder), "a GET makes no folder")
        os.makedirs(self.folder)
        self.assertEqual(self.latest()[:3:2], (404, self.NO_BACKUP), "an empty folder")
        self.decoys()
        self.assertEqual(http_request(self.port, "GET", serve.BACKUP_PATH)[2]["files"], [], "none of them is listed")
        status, _, payload, raw = self.latest()
        self.assertEqual((status, payload), (404, self.NO_BACKUP))
        self.assertNotIn(b"OUTSIDE", raw)

    def test_the_newest_kept_backup_is_sent_byte_for_byte(self):
        texts = {day: BackupApiTest.backup_text(day, prompts=3) for day in ("2026-11-09", "2026-11-11", "2026-11-10")}
        for day, text in texts.items():
            self.put("marginalia-backup-%s.json" % day, text.encode("utf-8"))
        self.decoys()
        listing = http_request(self.port, "GET", serve.BACKUP_PATH)[2]
        self.assertEqual(listing["files"][0]["name"], self.NAME, "GET /api/backup's last")
        newest = texts["2026-11-11"].encode("utf-8")
        for port in (self.port, self.app_port):
            for site in (None, "same-origin", "none"):
                with self.subTest(port=port, site=site):
                    status, headers, _, raw = self.latest(port, {"Sec-Fetch-Site": site} if site else None)
                    self.assertEqual((status, raw), (200, newest))
                    self.assertEqual(headers.get("x-marginalia-backup-name"), self.NAME)
                    self.assertEqual(headers.get("content-type"), "application/json; charset=utf-8")
                    self.assertEqual(headers.get("content-length"), str(len(newest)))
                    self.assertEqual(headers.get("cache-control"), "no-store")
                    self.assertEqual(headers.get("x-content-type-options"), "nosniff")
                    self.assertFalse([k for k in headers if k.startswith("access-control-")], "no CORS")
        status, headers, _, raw = self.latest(headers={"Host": "localhost:%d" % self.port})
        self.assertEqual((status, raw), (200, newest))
        # a later backup written through the API is the newest from then on (on the app's server: its page's header)
        serve.today = lambda: "2026-11-12"
        body = ('{"mode":"manual","backup":' + texts["2026-11-09"] + "}").encode("utf-8")
        h = dict(post_headers(self.app_port), **{serve.CLIENT_HEADER: serve.APP_CLIENT})
        status, _, payload, _ = http_request(self.app_port, "POST", serve.BACKUP_PATH, body, h)
        self.assertEqual((status, payload["file"]), (200, "marginalia-backup-2026-11-12.json"), payload)
        status, headers, _, raw = self.latest()
        self.assertEqual((status, headers.get("x-marginalia-backup-name"), raw),
                         (200, "marginalia-backup-2026-11-12.json", texts["2026-11-09"].encode("utf-8")))

    def test_another_site_and_other_machines_get_nothing(self):
        self.put(self.NAME, BackupApiTest.backup_text().encode("utf-8"))
        for port in (self.port, self.app_port, self.bare_port):
            for site in ("cross-site", "same-site", "Cross-Site"):
                with self.subTest(port=port, site=site):
                    status, headers, payload, _ = self.latest(port, {"Sec-Fetch-Site": site})
                    self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden site"}))
                    self.assertNotIn("x-marginalia-backup-name", headers)
            status, _, payload, _ = self.latest(port, {"Host": "rebind.example:%d" % port})
            self.assertEqual((status, payload), (403, {"ok": False, "error": "forbidden host"}))
        for httpd in (self.httpd, self.app):
            self.assertEqual(via_socket(httpd, ("192.168.1.20", 50000), "GET", serve.LATEST_PATH),
                             (403, {"ok": False, "error": "forbidden client"}))
        # refused before the folder is read: another site cannot even tell a backup from none
        shutil.rmtree(self.folder)
        self.assertEqual(self.latest(headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_a_symlink_or_a_fifo_put_in_its_place_is_never_followed(self):
        path = os.path.join(self.folder, self.NAME)
        os.makedirs(self.folder)
        os.symlink(self.secret, path)
        serve.backup_files = lambda folder: [(self.NAME, 100)]     # as if it was a regular file when the folder was read
        status, headers, payload, raw = self.latest()
        self.assertEqual(status, 500, payload)
        self.assertIn(self.NAME, payload["error"])
        self.assertNotIn(b"OUTSIDE", raw)
        self.assertNotIn("x-marginalia-backup-name", headers)
        os.remove(path)
        os.mkfifo(path)
        started = time.monotonic()
        status, _, payload, _ = self.latest()
        self.assertEqual(status, 500, payload)
        self.assertLess(time.monotonic() - started, 5, "a FIFO never blocks the server")
        os.remove(path)
        self.assertEqual(self.latest()[0], 500, "gone since the folder was read")

    def test_a_large_backup_is_streamed_in_pieces_and_one_cut_short_never_arrives_whole(self):
        big = ('{"format":"marginalia","version":1,"collections":[],"prompts":[],"pad":"%s"}'
               % ("éx" * (2 * serve.PDF_CHUNK + 5))).encode("utf-8")
        self.put(self.NAME, big)
        opened = []
        real_open = self.saved["open_regular"]

        def recording(folder, name, shrink=False):
            f = real_open(folder, name)
            opened.append(_Reads(f, os.path.join(folder, name), shrink) if f else None)
            return opened[-1]
        serve.open_regular = recording
        status, headers, _, raw = self.latest()
        self.assertEqual((status, len(raw), raw == big), (200, len(big), True))
        self.assertEqual(headers.get("content-length"), str(len(big)))
        self.assertGreater(len(opened[0].sizes), 2)
        self.assertLessEqual(max(opened[0].sizes), serve.PDF_CHUNK, "never read whole")
        # a file that gets shorter while it is sent: cut off, the connection closed, the page sees a cut body
        logged = []
        handler = self.httpd.RequestHandlerClass.func
        saved_log = handler.__dict__["log_message"]
        handler.log_message = lambda h, fmt, *args: logged.append(fmt % args)
        serve.open_regular = lambda folder, name: recording(folder, name, shrink=True)
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
            conn.request("GET", serve.LATEST_PATH, headers={"Host": "127.0.0.1:%d" % self.port})
            r = conn.getresponse()
            self.assertEqual((r.status, r.getheader("Content-Length")), (200, str(len(big))))
            with self.assertRaises(http.client.IncompleteRead):
                r.read()
            conn.close()
        finally:
            handler.log_message = saved_log
        self.assertIn("Backups: %s got shorter while it was being sent, so it was cut off" % self.NAME, logged)



class ZoteroApiTest(unittest.TestCase):
    """DECISIONS D34, step 2: /api/zotero/books on the desktop app's server (the page POSTs its books' SHA-256s and
    prompts, Marginalia for Zotero GETs them) beside a server made without --app (404 for both, as an unknown route).
    In memory only: each server has its own, and nothing is written to disk."""

    VERSION = "1.2.3"
    A, B = "a" * 64, "B" * 64

    @classmethod
    def setUpClass(cls):
        cls.app, cls.app_thread = serve_in_thread(app_version=cls.VERSION)
        cls.plain, cls.plain_thread = serve_in_thread()
        cls.app_port, cls.plain_port = cls.app.server_address[1], cls.plain.server_address[1]

    @classmethod
    def tearDownClass(cls):
        stop_in_thread(cls.app, cls.app_thread)
        stop_in_thread(cls.plain, cls.plain_thread)

    def put(self, books, port=None, client=serve.APP_CLIENT, headers=None):
        port = port or self.app_port
        h = dict(post_headers(port))
        if client is not None:
            h[serve.CLIENT_HEADER] = client
        h.update(headers or {})
        return http_request(port, "POST", serve.ZOTERO_PATH, {"books": books}, h)

    def got(self, port=None, headers=None):
        status, _, payload, _ = http_request(port or self.app_port, "GET", serve.ZOTERO_PATH, headers=headers)
        return status, payload

    def test_the_page_says_its_books_and_zotero_reads_them(self):
        status, headers, payload, _ = self.put([{"sha256": self.A, "prompts": 3}, {"sha256": self.B, "prompts": 0},
                                                {"sha256": self.A.upper(), "prompts": 2}])
        self.assertEqual((status, payload), (200, {"ok": True, "books": 2}))
        status, payload = self.got()
        self.assertEqual(status, 200)
        self.assertEqual(payload["books"], {self.A: 5, self.B.lower(): 0}, "lower case; a SHA-256 twice adds up")
        self.assertIsInstance(payload["at"], int)
        _, headers, _, _ = http_request(self.app_port, "GET", serve.ZOTERO_PATH)
        self.assertEqual((headers.get("cache-control"), headers.get("x-content-type-options")), ("no-store", "nosniff"))
        self.assertFalse([k for k in headers if k.startswith("access-control-")], "no CORS")
        # the next POST replaces the list: a book that is gone is gone
        self.assertEqual(self.put([{"sha256": self.B, "prompts": 1}])[0], 200)
        self.assertEqual(self.got()[1]["books"], {self.B.lower(): 1})
        self.assertEqual(self.put([])[0], 200)
        self.assertEqual(self.got()[1]["books"], {})

    def test_a_bad_list_is_refused_and_keeps_what_was_there(self):
        self.assertEqual(self.put([{"sha256": self.A, "prompts": 4}])[0], 200)
        for bad in ([{"sha256": "abc", "prompts": 1}], [{"sha256": self.A, "prompts": -1}],
                    [{"sha256": self.A, "prompts": True}], [{"sha256": self.A, "prompts": 1.5}], [{"sha256": self.A}],
                    ["x"], [{"sha256": self.A, "prompts": serve.MAX_ZOTERO_PROMPTS + 1}]):
            status, _, payload, _ = self.put(bad)
            self.assertEqual((status, payload["ok"]), (400, False), bad)
        status, _, payload, _ = http_request(self.app_port, "POST", serve.ZOTERO_PATH, {"list": []},
                                             dict(post_headers(self.app_port), **{serve.CLIENT_HEADER: "app"}))
        self.assertEqual(status, 400)
        too_many = [{"sha256": "%064x" % i, "prompts": 1} for i in range(serve.MAX_ZOTERO_BOOKS + 1)]
        self.assertEqual(self.put(too_many)[0], 400)
        self.assertEqual(oversized(self.app_port, serve.ZOTERO_PATH, serve.MAX_ZOTERO_BODY + 1), 413)
        self.assertEqual(self.got()[1]["books"], {self.A: 4})

    def test_only_the_apps_page_writes_and_another_site_cannot_read(self):
        self.assertEqual(self.put([{"sha256": self.A, "prompts": 7}])[0], 200)
        for client in (None, serve.MOVE_CLIENT, "browser"):
            status, _, payload, _ = self.put([{"sha256": self.A, "prompts": 0}], client=client)
            self.assertEqual((status, payload["error"]), (409, serve.APP_ONLY), client)
        for h in ({"Origin": "https://example.com"}, {"X-Marginalia": "0"}, {"Content-Type": "text/plain"}):
            self.assertEqual(self.put([], headers=h)[0] // 100, 4, h)
        self.assertEqual(self.got()[1]["books"], {self.A: 7}, "none of those changed it")
        self.assertEqual(self.got(headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.got(headers={"Sec-Fetch-Site": "same-origin"})[0], 200)
        self.assertEqual(self.got(headers={"Host": "rebind.example:%d" % self.app_port})[0], 403)

    def test_without_the_app_there_is_no_such_route(self):
        unknown = http_request(self.plain_port, "GET", "/api/no-such-route")[2]
        self.assertEqual(self.got(port=self.plain_port), (404, unknown))
        status, _, payload, _ = self.put([{"sha256": self.A, "prompts": 1}], port=self.plain_port)
        self.assertEqual((status, payload), (404, {"ok": False, "error": "not found"}))
        other, thread = serve_in_thread(app_version=self.VERSION)
        try:
            self.assertEqual(self.got(port=other.server_address[1])[1]["books"], {}, "each server has its own list")
            self.assertIsNone(self.got(port=other.server_address[1])[1]["at"])
        finally:
            stop_in_thread(other, thread)


if __name__ == "__main__":
    unittest.main()
