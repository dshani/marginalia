"""Tests for bin/marginalia, the user's command: the Marginalia Mac app (FEATURES E2.4) and everything it did before.

Run from the app folder:  python3 -I -m unittest discover -s test -p 'test_*.py'

Each test copies bin/marginalia into a fresh temp folder laid out like the project (<root>/bin/marginalia,
<root>/marginalia with index.html and tools/serve.py, <root>/desktop with a package.json) and runs it there with
stand-ins for every command that would reach outside the temp folder: open, osascript, lsregister, npm and pgrep (and
node and python3 for `test` and `build`) are one small script on PATH, ahead of the system's, that records each call
and acts on a state folder (setUp checks that each of them is found there and nowhere else). So nothing opens a browser
or an app, nothing quits an app, nothing is registered with LaunchServices and nothing is built. Some install tests
also put stand-ins for ditto and mv there: they run the system's ditto and mv, except that ditto can stop half way
until the test lets it go on, and mv can refuse one move or, after one move, send a signal to the command's own process
group (only when the command runs in a session of its own). MARGINALIA_APP names a Marginalia.app in the temp folder;
the servers the command starts get a free port (MARGINALIA_PORT, never 8765, 8791 or 8792), a fake HOME (so no Obsidian
vault list) and a temp backup folder (MARGINALIA_BACKUP_DIR), and are stopped afterwards. MARGINALIA_APP_PORT, the port
the command treats as the installed app's (the app itself always uses 8765), is a free port too: only `help` runs
without it. "The app runs" means a sleep process the test starts and pgrep's stand-in names (osascript's stand-in ends
it, as quitting would); only processes a test started are ever signalled. One test runs the real pgrep with the
pattern the command uses, against a copy of /bin/sleep inside the temp app, to check that pattern.

WithoutTheAppTest: with no Marginalia.app (or another app in its place) open, start, stop, restart and status run the
command's own server as before (the same words and the same browser fallbacks), build is unchanged, web is gone (it
opened the claude.ai copy, which the user deleted on 2026-11-11), help also lists app, and test also runs node --test in
desktop/.
WithTheAppTest: marginalia and start stop the command's own server and open the app; stop quits the app (AppleScript by
bundle id, SIGTERM when Apple events are refused, at most 10 s) and the command's server; restart is stop then start;
status names the app (version, running, pid) and what holds the app's port, which is 8765 (MARGINALIA_APP_PORT in the
tests) whatever MARGINALIA_PORT says; MARGINALIA_APP must be a whole .app path.
InstallTest: marginalia app refuses while the app runs, builds and tests with npm run app in desktop/, and only then
copies the new app next to the installed one (<app>.new) with ditto, moves the installed copy to desktop/out/previous
(the older previous copy set aside as Marginalia.app.old until the end), renames the new copy into place and registers
it (lsregister -f; the build copy and the previous copy -u), then deletes the build copy; a failed build, a build with no app, a failed copy or move,
the app opened during the build, or Ctrl+C (INT), a closed Terminal window (HUP) or TERM while it installs leave the
installed copy and the previous copy as they were (exit 1, or the signal), and what a killed install left behind is
cleared by the next one.
"""
import json
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
COMMAND = os.path.join(os.path.dirname(APP), "bin", "marginalia")
SERVE_PY = os.path.join(APP, "tools", "serve.py")
BUNDLE_ID = "local.marginalia.desktop"
STUBBED = ("open", "osascript", "lsregister", "npm", "pgrep")
APPLESCRIPT = ('if application id "local.marginalia.desktop" is running then '
               'tell application id "local.marginalia.desktop" to quit')
SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

STUB = r'''
import json, os, plistlib, shutil, signal, subprocess, sys, time

state = os.environ["STUB_STATE"]
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(os.path.join(state, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"cmd": name, "args": args, "cwd": os.getcwd()}) + "\n")


def setting(key, default=""):
    path = os.path.join(state, key)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def write(path, text, mode=0o644):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, mode)


if name == "open":                                   # exit 1 for an app named in open.fails
    sys.exit(1 if set(args) & set(setting("open.fails").splitlines()) else 0)
if name == "pgrep":                                  # the app "runs" while app.pid names its process
    if setting("app.pid"):
        print(setting("app.pid"))
        sys.exit(0)
    sys.exit(1)
if name == "osascript":                              # quits (ends the app's process), fails (no Apple events), ignores
    mode = setting("osascript.mode", "quits")
    if mode == "fails":
        sys.stderr.write("execution error: Not authorized to send Apple events to Marginalia. (-1743)\n")
        sys.exit(1)
    if mode == "quits" and setting("app.pid"):
        os.kill(int(setting("app.pid")), signal.SIGTERM)
        os.remove(os.path.join(state, "app.pid"))
    sys.exit(0)
if name == "npm":                                    # npm run app: builds, fails, makes-nothing, other-app, unreadable
    mode = setting("npm.mode", "builds")
    if setting("npm.opens-app"):                     # the person opens the installed app while the build runs
        write(os.path.join(state, "app.pid"), setting("npm.opens-app"))
    if mode == "fails":
        print("[build] the self-test failed")
        sys.exit(1)
    if mode != "makes-nothing":
        version = setting("npm.version", "1.2.3")
        app = os.path.join(os.getcwd(), "out", "Marginalia-darwin-arm64", "Marginalia.app")
        shutil.rmtree(app, ignore_errors=True)
        os.makedirs(os.path.join(app, "Contents", "MacOS"))
        os.makedirs(os.path.join(app, "Contents", "Resources"))
        with open(os.path.join(app, "Contents", "Info.plist"), "wb") as f:
            plistlib.dump({"CFBundleIdentifier": "com.example.other" if mode == "other-app" else
                           "local.marginalia.desktop", "CFBundleShortVersionString": version,
                           "CFBundleExecutable": "Marginalia"}, f)
        write(os.path.join(app, "Contents", "MacOS", "Marginalia"), "#!/bin/sh\nexit 0\n", 0o755)
        write(os.path.join(app, "Contents", "Resources", "build.txt"), "build " + version)
        if mode == "unreadable":                     # ditto cannot copy it: the install must fail and undo itself
            write(os.path.join(app, "Contents", "Resources", "unreadable.bin"), "x", 0)
    print("[build] done")
    sys.exit(0)
if name == "ditto":                                  # the system's ditto; "waits": half a copy, then wait for ditto.go
    if setting("ditto.mode") == "waits":
        for sig in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
            signal.signal(sig, signal.SIG_DFL)       # as the real ditto: a signal ends it
        os.makedirs(os.path.join(args[-1], "Contents", "MacOS"), exist_ok=True)
        write(os.path.join(args[-1], "Contents", "MacOS", "Marginalia"), "half")
        write(os.path.join(state, "ditto.started"), str(os.getpid()))
        deadline = time.monotonic() + 20
        while not os.path.exists(os.path.join(state, "ditto.go")) and time.monotonic() < deadline:
            time.sleep(0.02)
    os.execv("/usr/bin/ditto", ["ditto"] + args)
if name == "mv":                                     # the system's mv; refuses the source named in mv.fails; after
    source = args[-2] if len(args) >= 2 else ""      # moving the one in mv.signal ("INT <path>"), sends that signal
    if source and source == setting("mv.fails"):     # to the command's process group
        sys.stderr.write("mv: rename %s to %s: Permission denied\n" % (source, args[-1]))
        sys.exit(1)
    code = subprocess.call(["/bin/mv"] + args)
    sig, _, after = setting("mv.signal").partition(" ")
    if code == 0 and sig and source == after:
        if os.getpgrp() != os.getppid():             # only a command that leads a group of its own (start_command)
            sys.stderr.write("mv stand-in: the command does not lead its own process group\n")
            sys.exit(3)
        signal.signal(getattr(signal, "SIG" + sig), signal.SIG_IGN)
        os.killpg(os.getpgrp(), getattr(signal, "SIG" + sig))
    sys.exit(code)
sys.exit(int(setting(name + ".exit", "0")))          # lsregister, node, python3: recorded only
'''


def free_port():
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        if port not in (8765, 8791, 8792):
            return port


def alive(pid):
    """True while the process `pid` exists (for processes launchd adopted: a child of this test is a Popen, polled)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def ere_escape(text):
    """`text` as the command escapes it for pgrep's extended regular expression."""
    return "".join("\\" + ch if ch in "[]\\.*^$()+?{}|" else ch for ch in text)


class CommandTestBase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="marginalia-command-"))
        self.root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(self.root, "bin"))
        shutil.copy2(COMMAND, os.path.join(self.root, "bin", "marginalia"))
        self.web = os.path.join(self.root, "marginalia")
        os.makedirs(os.path.join(self.web, "tools"))
        shutil.copy2(os.path.join(APP, "index.html"), self.web)
        shutil.copy2(SERVE_PY, os.path.join(self.web, "tools"))
        self.desktop = os.path.join(self.root, "desktop")
        os.makedirs(os.path.join(self.desktop, "node_modules"))        # as after `npm ci`
        with open(os.path.join(self.desktop, "package.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "marginalia-desktop", "version": "1.2.3", "scripts": {"app": "node scripts/build.js"}}, f)
        self.state = os.path.join(self.tmp, "state")
        self.stubs = os.path.join(self.tmp, "stubs")
        self.pybin = os.path.join(self.tmp, "python")
        self.home = os.path.join(self.tmp, "home")
        self.logs = os.path.join(self.tmp, "logs")
        for d in (self.state, self.stubs, self.pybin, self.home, self.logs):
            os.makedirs(d)
        self.stub = os.path.join(self.tmp, "stub.py")
        with open(self.stub, "w", encoding="utf-8") as f:
            f.write("#!%s -I\n" % sys.executable + STUB)
        os.chmod(self.stub, 0o755)
        os.symlink(sys.executable, os.path.join(self.pybin, "python3"))     # the command's python3: this one
        self.applications = os.path.join(self.tmp, "Applications")
        os.makedirs(self.applications)
        self.installed = os.path.join(self.applications, "Marginalia.app")
        self.backups = os.path.join(self.tmp, "backups")
        self.port = free_port()
        self.ports = [self.port]    # every port a server of this test may listen on (tearDown looks at each)
        self.url = "http://127.0.0.1:%d/" % self.port
        self.log = os.path.join(self.logs, "marginalia-%d.log" % self.port)
        self.started = []           # processes this test started itself (servers, other programs, the app's stand-in)

    def tearDown(self):
        for p in self.started:
            if isinstance(p, int):
                if alive(p):
                    os.kill(p, signal.SIGKILL)
            else:
                self.end(p)
        for port in self.ports:
            pid = self.listener(port)
            if pid and self.tmp in self.command_line(pid):      # a server the command started here, and only that
                os.kill(pid, signal.SIGTERM)
                self.wait_gone(pid)
        for folder, _, _ in os.walk(self.tmp):                  # a test may have made a folder read-only
            os.chmod(folder, 0o755)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers

    def another_port(self):
        """A second free port for this test (never 8765, 8791 or 8792, never self.port)."""
        while True:
            port = free_port()
            if port not in self.ports:
                self.ports.append(port)
                return port

    def path(self, stubbed=STUBBED + ("node",), python_stub=False, extra=()):
        """PATH for the command: the stand-ins named in `stubbed` and `extra` (ditto, mv) (and python3's with
        python_stub), then this python3, then the system's folders."""
        wanted = set(stubbed) | set(extra) | ({"python3"} if python_stub else set())
        for name in STUBBED + ("node", "python3", "ditto", "mv"):
            link = os.path.join(self.stubs, name)
            if name in wanted and not os.path.lexists(link):
                os.symlink(self.stub, link)
            elif name not in wanted and os.path.lexists(link):
                os.remove(link)
        return os.pathsep.join([self.stubs, self.pybin] + SYSTEM_PATH)

    def command_env(self, args, env=None, path=None):
        """The command's environment: temp folders, free ports and the stand-ins first on PATH (checked)."""
        e = {"PATH": path or self.path(), "HOME": self.home, "TMPDIR": self.logs, "MARGINALIA_APP": self.installed,
             "MARGINALIA_PORT": str(self.port), "MARGINALIA_APP_PORT": str(self.port),
             "MARGINALIA_BACKUP_DIR": self.backups, "STUB_STATE": self.state}
        e.update(env or {})
        e = {k: v for k, v in e.items() if v is not None}
        for name in STUBBED:                        # a stand-in, or (npm only) nothing: never the system's command
            found = shutil.which(name, path=e["PATH"])
            self.assertTrue(found is None and name == "npm" or found == os.path.join(self.stubs, name),
                            "%s resolves to %s" % (name, found))
        self.assertNotIn(e["MARGINALIA_PORT"], ("8765", "8791", "8792"))
        if list(args[:1]) not in (["help"], ["-h"], ["--help"]):     # only help may leave the app's port at 8765
            self.assertNotIn(e.get("MARGINALIA_APP_PORT", "8765"), ("8765", "8791", "8792"))
        return e

    def run_command(self, *args, env=None, path=None, timeout=90):
        """bin/marginalia (the copy in <root>/bin) with `args` -> (exit code, stdout, stderr)."""
        e = self.command_env(args, env, path)
        p = subprocess.run([os.path.join(self.root, "bin", "marginalia")] + list(args), env=e, cwd=self.tmp,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def start_command(self, *args, env=None, path=None):
        """bin/marginalia with `args`, running, in a session of its own: a signal can go to its whole process group,
        as Ctrl+C or a closed Terminal window sends it, and to nothing else. -> its Popen."""
        e = self.command_env(args, env, path)
        p = subprocess.Popen([os.path.join(self.root, "bin", "marginalia")] + list(args), env=e, cwd=self.tmp,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True)
        self.started.append(p)
        return p

    def calls(self, name=None):
        path = os.path.join(self.state, "calls.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            out = [json.loads(line) for line in f]
        return [c for c in out if name is None or c["cmd"] == name]

    def forget_calls(self):
        path = os.path.join(self.state, "calls.jsonl")
        if os.path.exists(path):
            os.remove(path)

    def set(self, key, value):
        with open(os.path.join(self.state, key), "w", encoding="utf-8") as f:
            f.write(value)

    def listener(self, port=None):
        port = port or self.port
        self.assertIn(port, self.ports)
        r = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"],
                           capture_output=True, text=True)
        pids = r.stdout.split()
        return int(pids[0]) if pids else None

    @staticmethod
    def command_line(pid):
        return subprocess.run(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="], capture_output=True,
                              text=True).stdout.strip()

    def wait_gone(self, pid, timeout=10):
        deadline = time.monotonic() + timeout
        while alive(pid):
            if time.monotonic() > deadline:
                self.fail("process %d did not end" % pid)
            time.sleep(0.05)

    def make_app(self, path, version="1.0.0", bundle_id=BUNDLE_ID, tag="installed"):
        """A stand-in Marginalia.app: an Info.plist with that bundle id and version, an executable, a build tag."""
        os.makedirs(os.path.join(path, "Contents", "MacOS"))
        os.makedirs(os.path.join(path, "Contents", "Resources"))
        with open(os.path.join(path, "Contents", "Info.plist"), "wb") as f:
            plistlib.dump({"CFBundleIdentifier": bundle_id, "CFBundleShortVersionString": version,
                           "CFBundleExecutable": "Marginalia"}, f)
        with open(os.path.join(path, "Contents", "MacOS", "Marginalia"), "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(path, "Contents", "MacOS", "Marginalia"), 0o755)
        with open(os.path.join(path, "Contents", "Resources", "build.txt"), "w", encoding="utf-8") as f:
            f.write(tag)

    def tag(self, app):
        with open(os.path.join(app, "Contents", "Resources", "build.txt"), encoding="utf-8") as f:
            return f.read()

    def app_runs(self):
        """The app's stand-in process: a sleep that launchd adopts (so it is gone, not a zombie, once it ends), named
        by pgrep's stand-in. -> its pid."""
        out = subprocess.run(["/bin/sh", "-c", "/bin/sleep 120 </dev/null >/dev/null 2>&1 & echo $!"],
                             capture_output=True, text=True, check=True).stdout
        pid = int(out.strip())
        self.started.append(pid)
        self.set("app.pid", str(pid))
        return pid

    def start_our_server(self, port=None):
        """The command's own server, started as it always was (with no app installed; on `port` when given: a
        MARGINALIA_PORT for that one run). -> its pid."""
        port = port or self.port
        self.assertFalse(os.path.exists(self.installed))
        code, out, err = self.run_command("start", env={"MARGINALIA_PORT": str(port), "MARGINALIA_APP_PORT": str(port)})
        self.assertEqual((code, out), (0, "Marginalia started at http://127.0.0.1:%d/\n" % port), err)
        pid = self.listener(port)
        self.assertIn("serve.py --port %d --dir %s" % (port, self.web), self.command_line(pid))
        return pid

    @staticmethod
    def end(p):
        """End a process this test started (a Popen: polled and reaped, never left a zombie that kill(0) still finds)."""
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(10)
        for f in (p.stdout, p.stderr):
            if f:
                f.close()

    def start_other_program(self, port=None):
        """Another program listening on the port (or on `port`). -> its Popen."""
        port = port or self.port
        self.assertIn(port, self.ports)
        code = ("import socket, sys, time\ns = socket.socket()\n"
                "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\ns.bind(('127.0.0.1', %d))\ns.listen()\n"
                "print('ready', flush=True)\ntime.sleep(120)\n" % port)
        p = subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True)
        self.started.append(p)
        line = p.stdout.readline().strip()
        if line != "ready":
            self.end(p)
            self.fail("the other program did not start")
        return p

    def start_apps_server(self, port=None):
        """The installed app's own server: its copy of serve.py, started as the app starts it (python3 -I -B -c GUARD
        <app>/Contents/Resources/web/tools/serve.py --port …; a throwaway sandbox and backup folder), on the port (or
        on `port`). -> its Popen."""
        port = port or self.port
        self.assertIn(port, self.ports)
        web = os.path.join(self.installed, "Contents", "Resources", "web")
        os.makedirs(os.path.join(web, "tools"), exist_ok=True)
        shutil.copy2(os.path.join(APP, "index.html"), web)
        shutil.copy2(SERVE_PY, os.path.join(web, "tools"))
        guard = "import runpy, sys\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')"
        p = subprocess.Popen([sys.executable, "-I", "-B", "-c", guard, os.path.join(web, "tools", "serve.py"),
                              "--port", str(port), "--bind", "127.0.0.1", "--dir", web, "--obsidian-sandbox",
                              os.path.join(self.tmp, "sandbox"), "--backup-dir", self.backups, "--app", "1.0.0"],
                             env={"HOME": self.home, "PATH": os.pathsep.join(SYSTEM_PATH)}, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True)
        self.started.append(p)
        self.assertTrue(p.stdout.readline().startswith("Marginalia: http://127.0.0.1:%d/" % port))
        return p


class WithoutTheAppTest(CommandTestBase):
    """No Marginalia.app at MARGINALIA_APP (or another app there): every command does what it did before E2.4."""

    def test_start_status_open_restart_and_stop_run_the_commands_own_server(self):
        self.assertEqual(self.run_command("status"), (0, "Marginalia is not running. Start it with: marginalia\n", ""))
        pid = self.start_our_server()
        self.assertEqual(self.run_command("status"),
                         (0, "Marginalia is running at %s (pid %d). Log: %s\n" % (self.url, pid, self.log), ""))
        self.assertEqual(self.run_command("start"), (0, "Marginalia is running at %s\n" % self.url, ""))
        # marginalia (and "open"): the page in Chrome, else Brave, else the default browser; MARGINALIA_BROWSER first
        for args in ((), ("open",)):
            self.forget_calls()
            self.assertEqual(self.run_command(*args), (0, "Marginalia is running at %s\n" % self.url, ""))
            self.assertEqual([c["args"] for c in self.calls()], [["-a", "Google Chrome", self.url]])
        self.set("open.fails", "Google Chrome")
        self.assertEqual(self.run_command(), (0, "Marginalia is running at %s\nGoogle Chrome is not installed, so the "
                                                 "page opened in Brave Browser.\n" % self.url, ""))
        self.set("open.fails", "Google Chrome\nBrave Browser")
        self.forget_calls()
        self.assertEqual(self.run_command(), (0, "Marginalia is running at %s\nGoogle Chrome is not installed, so the "
                                                 "page opened in your default browser.\n" % self.url, ""))
        self.assertEqual([c["args"] for c in self.calls()],
                         [["-a", "Google Chrome", self.url], ["-a", "Brave Browser", self.url], [self.url]])
        self.set("open.fails", "Safari")
        self.forget_calls()
        code, out, err = self.run_command(env={"MARGINALIA_BROWSER": "Safari"})
        self.assertEqual((code, out, err), (0, "Marginalia is running at %s\n" % self.url,
                                            "Could not open Safari, so trying Chrome.\n"))
        self.assertEqual([c["args"] for c in self.calls()], [["-a", "Safari", self.url], ["-a", "Google Chrome", self.url]])
        self.set("open.fails", "")
        # restart: stop, start, open
        self.forget_calls()
        self.assertEqual(self.run_command("restart"),
                         (0, "Marginalia stopped.\nMarginalia started at %s\n" % self.url, ""))
        self.assertFalse(alive(pid))
        self.assertEqual([c["args"] for c in self.calls()], [["-a", "Google Chrome", self.url]])
        pid = self.listener()
        self.assertIn("serve.py --port %d --dir %s" % (self.port, self.web), self.command_line(pid))
        self.assertEqual(self.run_command("stop"), (0, "Marginalia stopped.\n", ""))
        self.assertFalse(alive(pid))
        self.assertIsNone(self.listener())
        self.assertEqual(self.run_command("stop"), (0, "Marginalia is not running.\n", ""))
        self.assertEqual({c["cmd"] for c in self.calls()}, {"open"}, "no app, osascript, pgrep, lsregister or npm")
        self.assertFalse(os.path.exists(os.path.join(self.home, "Documents")), "the server kept to its temp folders")

    def test_another_program_on_the_port_is_left_running(self):
        other = self.start_other_program()
        pid = other.pid
        code, out, err = self.run_command("start")
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(err, "Port %d is used by another program (pid %d):\n%s\nStop that program, or use another port: "
                              "MARGINALIA_PORT=%d marginalia\nAnother port is another address, so the browser shows a "
                              "separate, empty library there.\n" % (self.port, pid, self.command_line(pid),
                                                                     self.port + 1))
        self.assertEqual(self.run_command(), (1, "", err))
        self.assertEqual(self.run_command("stop"),
                         (1, "", "Port %d belongs to another program (pid %d), so it was left running.\n"
                          % (self.port, pid)))
        self.assertEqual(self.run_command("status"),
                         (0, "Marginalia is not running. Port %d is used by another program (pid %d).\n"
                          % (self.port, pid), ""))
        self.assertIsNone(other.poll(), "still running")
        self.assertEqual(self.calls(), [], "no browser opened")

    def test_another_app_or_no_app_at_marginalia_app_changes_nothing(self):
        self.make_app(self.installed, bundle_id="com.example.marginalia")
        for env in ({}, {"MARGINALIA_APP": os.path.join(self.tmp, "nowhere", "Marginalia.app")}):
            with self.subTest(env=env):
                self.assertEqual(self.run_command("status", env=env),
                                 (0, "Marginalia is not running. Start it with: marginalia\n", ""))
                self.assertEqual(self.run_command("stop", env=env), (0, "Marginalia is not running.\n", ""))
        self.assertEqual(self.calls(), [])

    def test_build_is_unchanged_and_web_and_unknown_commands_are_refused(self):
        self.assertEqual(self.run_command("build", path=self.path(python_stub=True)), (0, "", ""))
        self.assertEqual([(c["cmd"], c["args"], c["cwd"]) for c in self.calls()],
                         [("python3", ["-I", "tools/bundle.py"], self.web),
                          ("python3", ["-I", "tools/bundle.py", "--artifact"], self.web)])
        self.forget_calls()
        # web opened the claude.ai copy, which the user deleted on 2026-11-11: it is an unknown command now
        for name in ("nope", "web"):
            code, out, err = self.run_command(name)
            self.assertEqual((code, out), (1, ""), name)
            self.assertTrue(err.startswith("Unknown command: %s\nmarginalia: run Marginalia on this Mac" % name), err)
        self.assertEqual(self.calls(), [])

    def test_help_lists_every_command_and_app(self):
        code, out, err = self.run_command("help")
        self.assertEqual((code, err), (0, ""))
        for line in ("marginalia: run Marginalia on this Mac and open it in Chrome",
                     "  marginalia            start the app if needed, then open it in Chrome",
                     "  marginalia stop       stop the app",
                     "  marginalia restart    restart the app, then open it in Chrome",
                     "  marginalia status     show whether the app is running",
                     "  marginalia test       run the unit tests and code checks",
                     "  marginalia build      rebuild the single-file and artifact bundles",
                     "  marginalia app        build the Mac app, test it, then install it as %s" % self.installed,
                     "  marginalia help       show this list",
                     "The app runs at %s from %s." % (self.url, self.web),
                     "Without Google Chrome the page opens in Brave, then in your default browser.",
                     'Set MARGINALIA_BROWSER (for example "Safari") to choose another browser.'):
            self.assertIn(line + "\n", out)
        self.assertNotIn("marginalia web", out)
        self.assertEqual(self.run_command("-h"), (0, out, ""))
        self.assertEqual(self.run_command("--help"), (0, out, ""))
        self.assertEqual(self.calls(), [])

    def test_test_runs_the_web_checks_then_the_desktop_tests(self):
        path = self.path(python_stub=True)
        self.assertEqual(self.run_command("test", path=path), (0, "", ""))
        web_checks = [("node", ["--test"], self.web), ("python3", ["-I", "tools/xref.py"], self.web),
                      ("node", ["tools/xref-rt.js"], self.web), ("node", ["tools/smoke.js"], self.web),
                      ("python3", ["-I", "-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"], self.web)]
        self.assertEqual([(c["cmd"], c["args"], c["cwd"]) for c in self.calls()],
                         web_checks + [("node", ["--test"], self.desktop)])
        # a failing check stops the run there
        self.forget_calls()
        self.set("python3.exit", "1")
        self.assertEqual(self.run_command("test", path=path)[0], 1)
        self.assertEqual([(c["cmd"], c["args"]) for c in self.calls()], [("node", ["--test"]),
                                                                        ("python3", ["-I", "tools/xref.py"])])
        # no desktop folder: the web checks alone, as before
        self.set("python3.exit", "0")
        os.remove(os.path.join(self.desktop, "package.json"))
        self.forget_calls()
        self.assertEqual(self.run_command("test", path=path), (0, "", ""))
        self.assertEqual([(c["cmd"], c["args"], c["cwd"]) for c in self.calls()], web_checks)
        # no node: as before
        code, out, err = self.run_command("test", path=self.path(stubbed=STUBBED))
        self.assertEqual((code, out, err), (1, "", "This needs node, which is not on your PATH.\n"))


class WithTheAppTest(CommandTestBase):
    """A Marginalia.app (bundle id local.marginalia.desktop) at MARGINALIA_APP: the commands work on the app."""

    def opened_app(self):
        return [c["args"] for c in self.calls("open")]

    def test_marginalia_and_start_stop_the_commands_server_then_open_the_app(self):
        pid = self.start_our_server()
        self.make_app(self.installed)
        self.forget_calls()
        code, out, err = self.run_command()
        self.assertEqual((code, out, err), (0, "Stopped the server that the marginalia command started at %s (the app "
                                               "uses that port).\nOpened the Marginalia app.\n" % self.url, ""))
        self.assertFalse(alive(pid))
        self.assertIsNone(self.listener())
        self.assertEqual(self.opened_app(), [["-a", self.installed]], "the app, never a browser")
        for args in (("start",), ("open",), ()):
            self.forget_calls()
            self.assertEqual(self.run_command(*args), (0, "Opened the Marginalia app.\n", ""))
            self.assertEqual(self.opened_app(), [["-a", self.installed]])
        # the app's own server, or another program, on the port: left alone (the app shows its own dialog)
        for start in (self.start_apps_server, self.start_other_program):
            other = start()
            self.assertEqual(self.run_command("start"), (0, "Opened the Marginalia app.\n", ""))
            self.assertIsNone(other.poll(), "still running")
            self.end(other)
        self.set("open.fails", self.installed)
        self.assertEqual(self.run_command(), (1, "", "Could not open %s.\n" % self.installed))
        self.assertEqual({c["cmd"] for c in self.calls()}, {"open"})

    def test_stop_quits_the_app_and_stops_the_commands_server(self):
        our = self.start_our_server()
        self.make_app(self.installed)
        app = self.app_runs()
        self.forget_calls()
        code, out, err = self.run_command("stop")
        self.assertEqual((code, out, err), (0, "The Marginalia app has quit.\nStopped the server that the marginalia "
                                               "command started at %s (the app uses that port).\n" % self.url, ""))
        self.assertFalse(alive(app))
        self.assertFalse(alive(our))
        self.assertEqual([(c["cmd"], c["args"]) for c in self.calls()],
                         [("pgrep", ["-f", "--", "^%s/Contents/MacOS/Marginalia( |$)" % ere_escape(self.installed)]),
                          ("osascript", ["-e", APPLESCRIPT])])
        # nothing runs
        self.forget_calls()
        self.assertEqual(self.run_command("stop"), (0, "The Marginalia app is not running.\n", ""))
        self.assertEqual([c["cmd"] for c in self.calls()], ["pgrep"], "no Apple event to an app that does not run")
        # Apple events refused: SIGTERM quits the app the same way
        app = self.app_runs()
        self.set("osascript.mode", "fails")
        self.forget_calls()
        self.assertEqual(self.run_command("stop"), (0, "The Marginalia app has quit.\n", ""))
        self.assertFalse(alive(app))
        self.assertEqual([c["cmd"] for c in self.calls()], ["pgrep", "osascript"])
        os.remove(os.path.join(self.state, "app.pid"))
        # another program on the port is never stopped
        other = self.start_other_program()
        self.assertEqual(self.run_command("stop"), (0, "The Marginalia app is not running.\n", ""))
        self.assertIsNone(other.poll(), "still running")

    def test_restart_quits_then_opens_and_an_app_that_does_not_quit_stops_it_there(self):
        self.make_app(self.installed)
        app = self.app_runs()
        self.forget_calls()
        self.assertEqual(self.run_command("restart"),
                         (0, "The Marginalia app has quit.\nOpened the Marginalia app.\n", ""))
        self.assertFalse(alive(app))
        self.assertEqual([c["cmd"] for c in self.calls()], ["pgrep", "osascript", "open"])
        # an app that does not quit within 10 s: said so, exit 1, and restart opens nothing
        app = self.app_runs()
        self.set("osascript.mode", "ignores")
        self.forget_calls()
        started = time.monotonic()
        code, out, err = self.run_command("restart")
        took = time.monotonic() - started
        self.assertEqual((code, out, err), (1, "", "The Marginalia app (pid %d) did not quit within 10 seconds. Quit it "
                                                   "with Cmd+Q, then try again.\n" % app))
        self.assertGreaterEqual(took, 9.5)
        self.assertLess(took, 30)
        self.assertTrue(alive(app))
        self.assertEqual([c["cmd"] for c in self.calls()], ["pgrep", "osascript"])

    def test_status_names_the_app_and_what_holds_the_port(self):
        self.make_app(self.installed, version="1.4.2")
        self.assertEqual(self.run_command("status"),
                         (0, "The Marginalia app 1.4.2 is installed at %s and not running. Open it with: marginalia\n"
                             "Port %d is free.\n" % (self.installed, self.port), ""))
        app = self.app_runs()
        server = self.start_apps_server()
        self.assertEqual(self.run_command("status"),
                         (0, "The Marginalia app 1.4.2 is installed at %s and running (pid %d).\nPort %d is used by "
                             "the app's server (pid %d).\n" % (self.installed, app, self.port, server.pid), ""))
        self.end(server)
        other = self.start_other_program()
        self.assertEqual(self.run_command("status")[1].splitlines()[1],
                         "Port %d is used by another program (pid %d), so the app cannot start its server there."
                         % (self.port, other.pid))
        self.end(other)
        shutil.rmtree(self.installed)
        ours = self.start_our_server()
        self.make_app(self.installed, version="1.4.2")
        self.assertEqual(self.run_command("status")[1].splitlines()[1],
                         "Port %d is used by the server that the marginalia command started (pid %d; log: %s). "
                         "marginalia stops it before it opens the app." % (self.port, ours, self.log))
        self.assertEqual({c["cmd"] for c in self.calls()}, {"pgrep"})

    def test_the_apps_port_is_8765_whatever_marginalia_port_says(self):
        # The app always runs its server on 8765 (desktop/main.js: only its --port flag changes that, and `open -a`
        # passes none); MARGINALIA_PORT moves only the command's own server. help names 8765 with MARGINALIA_PORT set:
        code, out, err = self.run_command("help", env={"MARGINALIA_APP_PORT": None})
        self.assertEqual((code, err), (0, ""))
        self.assertIn("\nmarginalia and start open it (after stopping this command's own server, so the app gets port "
                      "8765),\nstop quits it, restart quits and opens it, and status shows it and port 8765.\n", out)
        self.assertNotIn(str(self.port), out.split("Once the Mac app")[1].replace(self.installed, ""))
        # In the tests MARGINALIA_APP_PORT stands for 8765: the command's servers on both ports, then the app.
        app_port = self.another_port()
        env = {"MARGINALIA_APP_PORT": str(app_port)}
        ours = self.start_our_server()                          # on MARGINALIA_PORT
        on_apps_port = self.start_our_server(app_port)          # started there when MARGINALIA_PORT was not set
        apps_port_log = os.path.join(self.logs, "marginalia-%d.log" % app_port)
        self.make_app(self.installed)
        self.forget_calls()
        self.assertEqual(self.run_command("status", env=env),
                         (0, "The Marginalia app 1.0.0 is installed at %s and not running. Open it with: marginalia\n"
                             "Port %d is used by the server that the marginalia command started (pid %d; log: %s). "
                             "marginalia stops it before it opens the app.\n"
                             "Port %d (MARGINALIA_PORT) is used by the server that the marginalia command started (pid "
                             "%d; log: %s). marginalia stops it before it opens the app.\n"
                             % (self.installed, app_port, on_apps_port, apps_port_log, self.port, ours, self.log), ""))
        self.assertEqual(self.run_command(env=env),
                         (0, "Stopped the server that the marginalia command started at http://127.0.0.1:%d/ (the app "
                             "uses that port).\nStopped the server that the marginalia command started at %s (the app "
                             "replaces it).\nOpened the Marginalia app.\n" % (app_port, self.url), ""))
        self.assertFalse(alive(ours))
        self.assertFalse(alive(on_apps_port))
        self.assertEqual(self.run_command("status", env=env),
                         (0, "The Marginalia app 1.0.0 is installed at %s and not running. Open it with: marginalia\n"
                             "Port %d is free.\n" % (self.installed, app_port), ""))
        # the app's server on its port; another program on MARGINALIA_PORT is not the app's business and stays
        app = self.app_runs()
        server = self.start_apps_server(app_port)
        other = self.start_other_program()
        self.assertEqual(self.run_command("status", env=env),
                         (0, "The Marginalia app 1.0.0 is installed at %s and running (pid %d).\nPort %d is used by "
                             "the app's server (pid %d).\n" % (self.installed, app, app_port, server.pid), ""))
        self.assertEqual(self.run_command("stop", env=env), (0, "The Marginalia app has quit.\n", ""))
        self.assertFalse(alive(app))
        self.assertIsNone(other.poll(), "still running")
        self.assertIsNone(server.poll(), "the app's server is the app's to stop")
        self.assertEqual({c["cmd"] for c in self.calls()}, {"pgrep", "open", "osascript"})

    def test_marginalia_app_must_name_a_whole_app(self):
        self.make_app(self.installed)
        for value, message in (("", "MARGINALIA_APP is set but empty; unset it, or set it to the whole path of "
                                    "Marginalia.app.\n"),
                               ("  ", "MARGINALIA_APP is set but empty; unset it, or set it to the whole path of "
                                      "Marginalia.app.\n"),
                               ("Applications/Marginalia.app", "MARGINALIA_APP must be the whole path of an app, "
                                "such as /Applications/Marginalia.app (it is: Applications/Marginalia.app).\n"),
                               (self.applications, "MARGINALIA_APP must be the whole path of an app, such as "
                                "/Applications/Marginalia.app (it is: %s).\n" % self.applications),
                               ("/", "MARGINALIA_APP must be the whole path of an app, such as "
                                     "/Applications/Marginalia.app (it is: ).\n")):
            for command in ("open", "start", "stop", "restart", "status", "app"):
                with self.subTest(value=value, command=command):
                    self.assertEqual(self.run_command(command, env={"MARGINALIA_APP": value}), (1, "", message))
        self.assertEqual(self.calls(), [], "nothing was opened, quit, built or started")
        self.assertIsNone(self.listener())
        self.assertEqual(self.run_command("status", env={"MARGINALIA_APP": self.installed + "//"})[0], 0)
        self.assertEqual(self.run_command("help", env={"MARGINALIA_APP": ""})[0], 0, "help needs no app")

    def test_the_pattern_finds_only_the_installed_apps_own_process(self):
        # the real pgrep with the pattern the command passes, on sleep processes whose command lines (exec -a) are the
        # app's executable and look-alikes, in a folder whose name holds a space and characters that mean something
        # in a pattern; a copy of /bin/sleep would not run (macOS stops a copied system binary)
        weird = os.path.join(self.tmp, "Apps (test) [1]+.x")
        os.makedirs(weird)
        installed = os.path.join(weird, "Marginalia.app")
        self.make_app(installed)
        mine = os.path.join(installed, "Contents", "MacOS", "Marginalia")
        others = [os.path.join(weird, "Marginalia2.app", "Contents", "MacOS", "Marginalia"),
                  os.path.join(installed, "Contents", "Frameworks", "Marginalia Helper (Renderer).app", "Contents",
                               "MacOS", "Marginalia Helper (Renderer)"),
                  mine + "2", "x" + mine, os.path.join(self.tmp, "Apps (test) [1]+.x", "MarginaliaXapp", "Contents",
                                                       "MacOS", "Marginalia")]
        self.run_command("status", env={"MARGINALIA_APP": installed})
        pattern = self.calls("pgrep")[0]["args"][-1]
        procs = {}
        for argv0 in others + [mine]:
            p = subprocess.Popen(["/bin/bash", "-c", 'exec -a "$1" /bin/sleep 60', "_", argv0],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.started.append(p)
            procs[argv0] = p.pid
        deadline = time.monotonic() + 10
        while any(not self.command_line(pid).startswith(argv0) for argv0, pid in procs.items()):
            self.assertLess(time.monotonic(), deadline, "the sleep processes did not start")
            time.sleep(0.05)
        found = subprocess.run(["/usr/bin/pgrep", "-f", "--", pattern], capture_output=True, text=True).stdout.split()
        self.assertEqual([int(x) for x in found], [procs[mine]], pattern)


class InstallTest(CommandTestBase):
    """marginalia app: npm run app (build plus self-test) in desktop/, then the install, only after it passed."""

    def built(self):
        return os.path.join(self.desktop, "out", "Marginalia-darwin-arm64", "Marginalia.app")

    def previous(self):
        return os.path.join(self.desktop, "out", "previous", "Marginalia.app")

    def staged(self):
        """Where the new app is copied before it is renamed into place: next to the installed one, not an app yet."""
        return self.installed + ".new"

    def set_aside(self):
        """Where the older previous copy waits until the new app is in place."""
        return self.previous() + ".old"

    def assert_no_leftovers(self):
        self.assertFalse(os.path.lexists(self.staged()), "no half copy next to the app")
        self.assertFalse(os.path.lexists(self.set_aside()), "no copy set aside")

    @staticmethod
    def tree(path):
        """Every folder and file under `path`, with each file's bytes and mode (None when nothing is there)."""
        if not os.path.lexists(path):
            return None
        out = []
        for folder, dirs, files in os.walk(path):
            entries = []
            for name in sorted(files):
                with open(os.path.join(folder, name), "rb") as f:
                    entries.append((name, f.read(), os.stat(os.path.join(folder, name)).st_mode))
            out.append((os.path.relpath(folder, path), sorted(dirs), entries))
        return sorted(out)

    def install_calls(self):
        return [(c["cmd"], c["args"], c["cwd"]) for c in self.calls() if c["cmd"] in ("npm", "lsregister", "open",
                                                                                      "osascript")]

    def test_app_builds_tests_and_installs_then_keeps_the_previous_copy(self):
        code, out, err = self.run_command("app")
        self.assertEqual((code, err), (0, ""), out)
        self.assertEqual(out, "Building and testing the Marginalia app (npm run app in %s).\n[build] done\n"
                              "Installed Marginalia 1.2.3. Open it with: marginalia\n" % self.desktop)
        self.assertEqual(self.install_calls(), [("npm", ["run", "app"], self.desktop),
                                                ("lsregister", ["-f", self.installed], self.tmp),
                                                ("lsregister", ["-u", self.built()], self.tmp)])
        self.assertEqual(self.tag(self.installed), "build 1.2.3")
        self.assertFalse(os.path.exists(self.built()), "the build copy is gone (D34: macOS would register it again)")
        self.assertFalse(os.path.exists(os.path.dirname(self.previous())), "nothing was installed before")
        # the next version: the installed copy goes to desktop/out/previous
        self.set("npm.version", "1.2.4")
        self.forget_calls()
        code, out, err = self.run_command("app")
        self.assertEqual((code, out.splitlines()[-1], err), (0, "Installed Marginalia 1.2.4. Open it with: marginalia", ""))
        self.assertEqual(self.install_calls(), [("npm", ["run", "app"], self.desktop),
                                                ("lsregister", ["-f", self.installed], self.tmp),
                                                ("lsregister", ["-u", self.built()], self.tmp),
                                                ("lsregister", ["-u", self.previous()], self.tmp)])
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("build 1.2.4", "build 1.2.3"))
        # and the one after replaces the older previous copy
        self.set("npm.version", "1.2.5")
        self.assertEqual(self.run_command("app")[0], 0)
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("build 1.2.5", "build 1.2.4"))
        self.assertEqual(os.listdir(os.path.dirname(self.previous())), ["Marginalia.app"])
        self.assertEqual(os.listdir(self.applications), ["Marginalia.app"], "no half copy or other copy left there")
        # the installed copy is what the build made (ditto: every file, the executable bit kept)
        self.assertTrue(os.access(os.path.join(self.installed, "Contents", "MacOS", "Marginalia"), os.X_OK))
        with open(os.path.join(self.installed, "Contents", "Info.plist"), "rb") as f:
            self.assertEqual(plistlib.load(f)["CFBundleShortVersionString"], "1.2.5")
        # and then "marginalia" opens it
        self.forget_calls()
        self.assertEqual(self.run_command(), (0, "Opened the Marginalia app.\n", ""))

    def test_app_refuses_while_the_app_runs(self):
        self.make_app(self.installed)
        app = self.app_runs()
        self.assertEqual(self.run_command("app"),
                         (1, "", "Quit Marginalia first (Cmd+Q), then run marginalia app again.\n"))
        self.assertEqual([c["cmd"] for c in self.calls()], ["pgrep"], "nothing built, nothing quit")
        self.assertTrue(alive(app))
        os.kill(app, signal.SIGTERM)
        self.wait_gone(app)
        os.remove(os.path.join(self.state, "app.pid"))
        # opened while the build ran: refused after it, and the installed copy stays
        self.set("npm.opens-app", str(self.app_runs()))
        os.remove(os.path.join(self.state, "app.pid"))
        code, out, err = self.run_command("app")
        self.assertEqual((code, err), (1, "Quit Marginalia first (Cmd+Q), then run marginalia app again.\n"))
        self.assertEqual(self.tag(self.installed), "installed")
        self.assertFalse(os.path.exists(self.previous()))
        self.assertEqual([c["cmd"] for c in self.calls("lsregister")], [])

    def test_a_failed_build_or_copy_leaves_the_installed_copy_as_it_was(self):
        self.make_app(self.installed)
        before = sorted(os.walk(self.installed))
        for mode, message in (("fails", "The build or its self-test failed, so the installed app was left as it is.\n"),
                              ("makes-nothing", "The build made no Marginalia app at %s, so the installed app was left "
                                                "as it is.\n" % self.built()),
                              ("other-app", "The build made no Marginalia app at %s, so the installed app was left as "
                                            "it is.\n" % self.built()),
                              ("unreadable", None)):
            with self.subTest(mode=mode):
                self.set("npm.mode", mode)
                self.forget_calls()
                code, out, err = self.run_command("app")
                self.assertEqual(code, 1, out + err)
                if message:
                    self.assertEqual(err, message)
                else:                                   # ditto failed half way: the old copy is put back
                    self.assertTrue(err.endswith("Could not copy the new app to %s, so the installed app was left as "
                                                 "it was.\n" % self.installed), err)
                self.assertEqual(sorted(os.walk(self.installed)), before)
                self.assertEqual(self.tag(self.installed), "installed")
                self.assertEqual(self.calls("lsregister"), [])
                self.assertEqual([c["cmd"] for c in self.calls("npm")], ["npm"])
        # no npm, or no desktop folder: nothing is built
        self.set("npm.mode", "builds")
        self.forget_calls()
        self.assertEqual(self.run_command("app", path=self.path(stubbed=("open", "osascript", "lsregister", "pgrep"))),
                         (1, "", "This needs npm, which is not on your PATH.\n"))
        os.rmdir(os.path.join(self.desktop, "node_modules"))
        self.assertEqual(self.run_command("app"), (1, "", "The Mac app's build tools are not installed yet. Install "
                                                          "them once with: cd \"%s\" && npm ci\n" % self.desktop))
        os.remove(os.path.join(self.desktop, "package.json"))
        self.assertEqual(self.run_command("app"), (1, "", "The Mac app's folder is missing: %s\n" % self.desktop))
        self.assertEqual(self.calls("npm"), [])
        self.assertEqual(self.tag(self.installed), "installed")

    def test_a_failed_copy_or_move_keeps_the_previous_copy_too(self):
        # The version before the installed one stays in desktop/out/previous whatever fails (it is the way back).
        self.make_app(self.installed, tag="installed")
        self.make_app(self.previous(), version="0.9.0", tag="previous")
        before = (self.tree(self.installed), self.tree(self.previous()))

        def check(code, err, message):
            self.assertEqual(code, 1, err)
            self.assertTrue(err.endswith(message), err)
            self.assertEqual((self.tree(self.installed), self.tree(self.previous())), before)
            self.assert_no_leftovers()
            self.assertEqual(self.calls("lsregister"), [])

        # ditto stops half way (a file in the build it cannot read)
        self.set("npm.mode", "unreadable")
        code, out, err = self.run_command("app")
        check(code, err, "Could not copy the new app to %s, so the installed app was left as it was.\n" % self.installed)
        # the installed copy cannot be moved to desktop/out/previous (macOS does not move a read-only folder to
        # another folder; the older copy was already set aside by then)
        self.set("npm.mode", "builds")
        os.chmod(self.installed, 0o555)
        try:
            code, out, err = self.run_command("app")
        finally:
            os.chmod(self.installed, 0o755)
        check(code, err, "Could not move the installed app to %s, so it was left as it is.\n" % self.previous())
        self.assertIn("Permission denied", err)
        # the last step fails, the new copy renamed into place: both copies go back where they were
        self.set("mv.fails", self.staged())
        self.forget_calls()
        code, out, err = self.run_command("app", path=self.path(extra=("mv",)))
        check(code, err, "Could not copy the new app to %s, so the installed app was left as it was.\n" % self.installed)
        self.assertEqual([c["args"] for c in self.calls("mv")],
                         [[self.previous(), self.set_aside()], [self.installed, self.previous()],
                          [self.staged(), self.installed],
                          [self.previous(), self.installed], [self.set_aside(), self.previous()]])

    def test_ctrl_c_a_closed_window_or_term_while_it_installs_puts_everything_back(self):
        # The signals a Terminal sends (Ctrl+C: INT to the whole process group; a closed window: HUP; logout: TERM)
        # while ditto copies, or between two moves, and TERM to the command alone: the command undoes what it did,
        # says so and ends by that signal; the app stays installed, so the next `marginalia` opens it.
        self.make_app(self.installed, tag="installed")
        self.make_app(self.previous(), version="0.9.0", tag="previous")
        before = (self.tree(self.installed), self.tree(self.previous()))
        started, go = os.path.join(self.state, "ditto.started"), os.path.join(self.state, "ditto.go")
        for name, to, when in (("INT", "group", "copy"), ("HUP", "group", "copy"), ("TERM", "group", "copy"),
                               ("TERM", "command", "copy"), ("INT", "group", "move")):
            with self.subTest(signal=name, to=to, when=when):
                sig = getattr(signal, "SIG" + name)
                for f in (started, go):
                    if os.path.exists(f):
                        os.remove(f)
                self.set("ditto.mode", "waits" if when == "copy" else "")
                self.set("mv.signal", "%s %s" % (name, self.installed) if when == "move" else "")
                self.forget_calls()
                p = self.start_command("app", path=self.path(extra=("ditto", "mv")))
                if when == "copy":
                    deadline = time.monotonic() + 60
                    while not os.path.exists(started):
                        self.assertIsNone(p.poll(), "the command ended before ditto ran")
                        self.assertLess(time.monotonic(), deadline, "ditto did not start")
                        time.sleep(0.02)
                    if to == "group":
                        os.killpg(p.pid, sig)
                    else:
                        os.kill(p.pid, sig)
                        self.set("ditto.go", "")                # ditto finishes; the command stops after it
                out, err = p.communicate(timeout=60)
                self.assertEqual(p.returncode, -sig, out + err)
                self.assertTrue(err.endswith("Stopped before the new app was in place, so the installed app was left "
                                             "as it was.\n"), err)
                self.assertEqual((self.tree(self.installed), self.tree(self.previous())), before)
                self.assert_no_leftovers()
                self.assertEqual(self.calls("lsregister"), [])
                self.assertEqual(self.run_command("status")[1].splitlines()[0], "The Marginalia app 1.0.0 is "
                                 "installed at %s and not running. Open it with: marginalia" % self.installed)
        # A signal once the new app is in place undoes nothing: the last steps run, then the command ends by it.
        self.set("ditto.mode", "")
        self.set("mv.signal", "INT %s" % self.staged())
        self.forget_calls()
        p = self.start_command("app", path=self.path(extra=("ditto", "mv")))
        out, err = p.communicate(timeout=60)
        self.assertEqual((p.returncode, out.splitlines()[-1], err),
                         (-signal.SIGINT, "Installed Marginalia 1.2.3. Open it with: marginalia", ""))
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("build 1.2.3", "installed"))
        self.assertEqual([c["args"][0] for c in self.calls("lsregister")], ["-f", "-u", "-u"])
        self.assertEqual(os.listdir(os.path.dirname(self.previous())), ["Marginalia.app"])
        self.assertEqual(os.listdir(self.applications), ["Marginalia.app"])
        # and the next run installs as usual
        self.set("mv.signal", "")
        self.set("npm.version", "1.2.4")
        code, out, err = self.run_command("app", path=self.path(extra=("ditto", "mv")))
        self.assertEqual((code, out.splitlines()[-1], err), (0, "Installed Marginalia 1.2.4. Open it with: marginalia", ""))
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("build 1.2.4", "build 1.2.3"))
        self.assertEqual(os.listdir(os.path.dirname(self.previous())), ["Marginalia.app"])
        self.assertEqual(os.listdir(self.applications), ["Marginalia.app"])

    def test_what_a_killed_install_left_is_cleared_by_the_next_one(self):
        # kill -9 or a power cut skips the undo. Killed after the older previous copy was set aside: it goes back to
        # desktop/out/previous, and the half copy next to the app is removed.
        self.make_app(self.installed, tag="installed")
        self.make_app(self.set_aside(), version="0.8.0", tag="older")
        os.makedirs(os.path.join(self.staged(), "Contents"))
        self.set("npm.mode", "unreadable")
        code, out, err = self.run_command("app")
        self.assertEqual(code, 1, err)
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("installed", "older"))
        self.assert_no_leftovers()
        # Killed after the installed copy went to desktop/out/previous: the set-aside copy is the older one and goes.
        self.make_app(self.set_aside(), version="0.7.0", tag="oldest")
        os.makedirs(os.path.join(self.staged(), "Contents"))
        self.set("npm.mode", "builds")
        code, out, err = self.run_command("app")
        self.assertEqual((code, err), (0, ""), out)
        self.assertEqual((self.tag(self.installed), self.tag(self.previous())), ("build 1.2.3", "installed"))
        self.assertEqual(os.listdir(os.path.dirname(self.previous())), ["Marginalia.app"])
        self.assertEqual(os.listdir(self.applications), ["Marginalia.app"])

    def test_app_never_replaces_another_app(self):
        self.make_app(self.installed, bundle_id="com.example.other", tag="someone else's")
        self.assertEqual(self.run_command("app"),
                         (1, "", "%s is not the Marginalia app, so it was left as it is. Set MARGINALIA_APP to install "
                                 "somewhere else.\n" % self.installed))
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.tag(self.installed), "someone else's")


if __name__ == "__main__":
    unittest.main()
