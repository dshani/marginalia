#!/usr/bin/env python3
"""Static cross-reference check for Marginalia modules.

Finds every `M.<ns>.<name>` (and `Marginalia.<ns>.<name>`) use in js/*.js and checks that
js/<ns>.js defines <name> (as an object property, assignment or function). Heuristic, no DOM.
Also checks the load order: index.html loads every js/*.js exactly once, in tools/smoke.js's ORDER.
Usage: python3 -I tools/xref.py   (from the marginalia/ folder or anywhere)
Exit code 1 when something is missing.
"""
import os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "js")
files = sorted(glob.glob(os.path.join(JS, "*.js")))
src = {os.path.basename(f)[:-3]: open(f, encoding="utf-8").read() for f in files}
use_re = re.compile(r"\b(?:M|Marginalia)\.([a-z][A-Za-z0-9]*)\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?")
missing, bad_ns = [], []
def defined(name, text):
    pats = [r"(?<![\w$.])" + re.escape(name) + r"\s*:",          # property in literal
            r"(?<![\w$.])" + re.escape(name) + r"\s*=[^=]",       # assignment
            r"\." + re.escape(name) + r"\s*=[^=]",                # api.name = / M.ns.name =
            r"function\s+" + re.escape(name) + r"\b",
            r"[\"']" + re.escape(name) + r"[\"']\s*:"]
    return any(re.search(p, text) for p in pats)
for fname, text in src.items():
    for lineno, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("//") or line.lstrip().startswith("*"):
            continue
        for m in use_re.finditer(line):
            ns, name, sub = m.group(1), m.group(2), m.group(3)
            if ns not in src:
                bad_ns.append((fname, lineno, ns)); continue
            target = src[ns]
            if not defined(name, target):
                missing.append((fname, lineno, ns + "." + name, line.strip()[:120]))
            elif sub and not defined(sub, target):
                missing.append((fname, lineno, ns + "." + name + "." + sub, line.strip()[:120]))
seen = set()
for f, l, ns in bad_ns:
    if (f, ns) not in seen:
        seen.add((f, ns)); print("NO MODULE  %s:%d  M.%s" % (f, l, ns))
for f, l, ref, line in missing:
    print("MISSING    %s:%d  %s    %s" % (f, l, ref, line))

# Load order: index.html loads every js/<name>.js exactly once (and nothing else from js/), in the order of
# tools/smoke.js's ORDER, which the headless boot and the tests that run the real modules use (30 modules, with
# js/similar.js between prompts.js and context.js, js/obsidian.js and js/backup.js between exporter.js and cache.js,
# js/stats.js between review.js and library.js, and js/tabs.js and js/desktop.js between library.js and app.js).
order_problems = []
try:
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    with open(os.path.join(ROOT, "tools", "smoke.js"), encoding="utf-8") as fh:
        smoke = fh.read()
    page = re.findall(r"""<script\s+src\s*=\s*["']js/([A-Za-z0-9_-]+)\.js["']\s*>\s*</script>""", html)
    om = re.search(r"\bvar ORDER = \[([^\]]*)\]", smoke)
    order = re.findall(r'"([A-Za-z0-9_-]+)"', om.group(1)) if om else None
    for name in sorted(src):
        if name not in page:
            order_problems.append("js/%s.js is not loaded by index.html" % name)
    for name in sorted(set(page)):
        if name not in src:
            order_problems.append("index.html loads js/%s.js, which does not exist" % name)
        if page.count(name) > 1:
            order_problems.append("index.html loads js/%s.js %d times" % (name, page.count(name)))
    if order is None:
        order_problems.append("tools/smoke.js has no ORDER list")
    elif order != page:
        order_problems.append("index.html loads %s but tools/smoke.js ORDER is %s" % (" ".join(page), " ".join(order)))
except OSError as e:
    order_problems.append("cannot read index.html or tools/smoke.js (%s)" % e)
for p in order_problems:
    print("LOAD ORDER " + p)
print("%d files, %d missing refs, %d unknown namespaces, %d load-order problems"
      % (len(src), len(missing), len(seen), len(order_problems)))
sys.exit(1 if (missing or seen or order_problems) else 0)
