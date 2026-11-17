#!/usr/bin/env python3
"""Bundle Marginalia into one HTML file. Standard library only; run it as `python3 -I tools/bundle.py`.

  python3 -I tools/bundle.py             -> dist/marginalia.html
      A full single-file document: every local stylesheet (styles.css, css/*.css) becomes an inline
      <style> block and every local script (js/*.js) an inline <script>, in document order. CDN tags
      (Google Fonts, katex.min.css, pdf.min.js, katex.min.js) are kept as <link>/<script src>.
      The build meta reads "local".

  python3 -I tools/bundle.py --artifact  -> dist/marginalia-artifact.html
      The claude.ai Artifact FRAGMENT of BUILD-NOTES "Artifact page contract": no <!doctype>, <html>,
      <head>, <body>, <meta charset> or viewport (the platform adds them). Output order:
        <title>Marginalia</title>
        the Google Fonts <link> (kept: the artifact CSP allows Google Fonts stylesheets)
        every <style> block: katex.min.css inlined with its woff2 fonts embedded as data: URIs
          (woff/ttf fallbacks dropped), then the local stylesheets in document order
        <meta name="marginalia-build" content="artifact">
        the #app markup (the body content without the scripts)
        the cdnjs <script src> tags, the inline worker script, the inlined local scripts and the
          inline boot script, in document order

Downloads land in tools/.cache/ under a safe file name derived from the URL and are reused when
present, so a second --artifact build runs offline. The output's byte size is printed. Exit status 1
when a local file referenced by index.html is missing (every missing file is listed before anything is
downloaded or written), when a download fails, or when the output exceeds 15 MB.
"""
import base64
import hashlib
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "tools", ".cache")
DIST_DIR = os.path.join(ROOT, "dist")
MAX_BYTES = 15 * 1024 * 1024
USER_AGENT = "marginalia-bundler/1.1"

LINK_RE = re.compile(r"<link\b[^>]*>", re.I)
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
HEAD_CSS_RE = re.compile(r"<link\b[^>]*>|<style\b[^>]*>.*?</style\s*>", re.I | re.S)
BUILD_META_RE = re.compile(r"""<meta\b[^>]*\bname\s*=\s*["']?marginalia-build["']?[^>]*>""", re.I)
TITLE_RE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.I | re.S)
FORBIDDEN_IN_FRAGMENT = re.compile(
    r"""<!doctype\b|<html\b|</html\b|<head\b|</head\b|<body\b|</body\b|<meta\s+charset\b|name\s*=\s*["']?viewport\b""",
    re.I)

STATS = {"styles": 0, "remote_styles": 0, "scripts": 0, "fonts": 0, "downloads": 0, "cached": 0}


class BuildError(Exception):
    """A build problem that is reported as one line on stderr with exit status 1."""


# --- small helpers --------------------------------------------------------------------------------

def attr(tag, name):
    """Value of attribute `name` in an HTML start tag (or an attribute string); None when absent."""
    m = re.search(r"""(?:^|\s)%s\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""" % re.escape(name), tag, re.I)
    if not m:
        return None
    for g in m.groups():
        if g is not None:
            return g.strip()
    return ""


def is_remote(url):
    return bool(re.match(r"^(https?:)?//", url or "", re.I))


def is_google_fonts(url):
    return bool(re.match(r"^(https?:)?//fonts\.googleapis\.com/", url or "", re.I))


def absolute(url):
    return "https:" + url if url.startswith("//") else url


def local_path(rel):
    rel = rel.split("?", 1)[0].split("#", 1)[0]
    return os.path.normpath(os.path.join(ROOT, rel))


def read_local(rel):
    with open(local_path(rel), "r", encoding="utf-8") as f:
        return f.read()


def rel_to_root(path):
    return os.path.relpath(path, ROOT)


# --- downloads with an on-disk cache -------------------------------------------------------------

def cache_path(url):
    """tools/.cache/<safe name>: the URL without its scheme, every unsafe character replaced by `_`."""
    name = re.sub(r"^(https?:)?//", "", url)
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    if len(name) > 150:  # keep the readable tail (the file name) and disambiguate with a hash
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        name = name[:80] + "_" + digest + "_" + name[-50:]
    return os.path.join(CACHE_DIR, name or "download")


_memo = {}


def fetch(url):
    """Bytes of `url`, from tools/.cache/ when present, else downloaded and cached (atomic write)."""
    url = absolute(url)
    if url in _memo:
        return _memo[url]
    path = cache_path(url)
    if os.path.isfile(path):
        with open(path, "rb") as f:
            data = f.read()
        STATS["cached"] += 1
    else:
        print("fetching", url)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
        except (OSError, ValueError) as e:  # URLError/HTTPError/timeouts are OSErrors
            raise BuildError("could not download %s: %s" % (url, e))
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        STATS["downloads"] += 1
    _memo[url] = data
    return data


# --- CSS / JS inlining ---------------------------------------------------------------------------

def inline_remote_css(href):
    """A CDN stylesheet with each @font-face reduced to one embedded woff2 data: URI."""
    href = absolute(href)
    css = fetch(href).decode("utf-8")
    base = href.rsplit("/", 1)[0] + "/"

    def embed_face(face_match):
        def embed_src(src_match):
            decl = src_match.group(0)
            w = re.search(r"""url\(\s*['"]?([^'")]+?\.woff2)['"]?\s*\)""", decl, re.I)
            if not w:
                return decl
            font_url = urllib.parse.urljoin(base, w.group(1))
            b64 = base64.b64encode(fetch(font_url)).decode("ascii")
            STATS["fonts"] += 1
            return 'src:url(data:font/woff2;base64,%s) format("woff2")' % b64
        return re.sub(r"src\s*:[^;}]*", embed_src, face_match.group(0))

    css = re.sub(r"@font-face\s*\{[^}]*\}", embed_face, css)
    # any other relative url() (none expected in katex) -> absolute, so it still resolves when inlined
    css = re.sub(r"""url\(\s*(['"]?)(?!data:|https?:|//)([^'")]+)\1\s*\)""",
                 lambda m: "url(%s)" % urllib.parse.urljoin(base, m.group(2)), css)
    return css


def style_block(label, css):
    return "<style>\n/* %s */\n%s\n</style>" % (label, css.replace("</style", "<\\/style"))


def script_block(label, js):
    return "<script>\n/* %s */\n%s\n</script>" % (label, js.replace("</script", "<\\/script"))


def transform_link(tag, artifact):
    """Replacement for a <link> tag: local stylesheet -> <style>; CDN stylesheet kept (local build) or
    inlined with fonts (artifact build, except Google Fonts, which stays a <link>)."""
    rel = (attr(tag, "rel") or "").lower().split()
    href = attr(tag, "href")
    if "stylesheet" not in rel or not href:
        return "" if artifact else tag  # icons, preconnects etc. have no place in a fragment
    if is_remote(href):
        if not artifact or is_google_fonts(href):
            return tag
        STATS["remote_styles"] += 1
        return style_block("inlined: " + href, inline_remote_css(href))
    STATS["styles"] += 1
    return style_block(href, read_local(href))


def transform_script(m):
    """Replacement for a <script> block: local src -> inline; CDN src and inline scripts kept as is."""
    src = attr(m.group(1), "src")
    if not src or is_remote(src):
        return m.group(0)
    STATS["scripts"] += 1
    return script_block(src, read_local(src))


# --- document parts ------------------------------------------------------------------------------

def local_refs(html):
    """Every local stylesheet href and script src referenced by the page, in document order."""
    refs = []
    for tag in LINK_RE.findall(html):
        rel = (attr(tag, "rel") or "").lower().split()
        href = attr(tag, "href")
        if "stylesheet" in rel and href and not is_remote(href):
            refs.append(href)
    for m in SCRIPT_RE.finditer(html):
        src = attr(m.group(1), "src")
        if src and not is_remote(src):
            refs.append(src)
    return refs


def set_build_meta(html, value):
    """Exactly one <meta name="marginalia-build" content="<value>"> in the document head."""
    tag = '<meta name="marginalia-build" content="%s">' % value
    seen = []

    def repl(m):
        seen.append(m.group(0))
        return tag if len(seen) == 1 else ""

    html = BUILD_META_RE.sub(repl, html)
    if not seen:
        html = re.sub(r"</head\s*>", "  " + tag + "\n</head>", html, count=1, flags=re.I)
    return html


def section(html, name):
    m = re.search(r"<%s\b[^>]*>(.*?)</%s\s*>" % (name, name), html, re.I | re.S)
    if not m:
        raise BuildError("index.html has no <%s>…</%s> section" % (name, name))
    return m.group(1)


def build_local(html):
    html = set_build_meta(html, "local")
    html = LINK_RE.sub(lambda m: transform_link(m.group(0), False), html)
    html = SCRIPT_RE.sub(transform_script, html)
    return html


def build_artifact(html):
    head = section(html, "head")
    body = section(html, "body")
    tm = TITLE_RE.search(head)
    title = (tm.group(1).strip() if tm else "") or "Marginalia"
    parts = ["<title>%s</title>" % title]
    for m in HEAD_CSS_RE.finditer(head):  # links and inline <style> blocks, in head order
        tag = m.group(0)
        out = tag if tag.lower().startswith("<style") else transform_link(tag, True)
        if out:
            parts.append(out)
    parts.append('<meta name="marginalia-build" content="artifact">')
    markup = SCRIPT_RE.sub("", body)
    markup = BUILD_META_RE.sub("", markup)
    markup = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", markup).strip()
    parts.append(markup)
    static = "\n".join(parts)
    bad = FORBIDDEN_IN_FRAGMENT.search(static)
    if bad:
        raise BuildError("the artifact fragment must not contain %r (found in the markup)" % bad.group(0))
    scripts = [transform_script(m) for m in SCRIPT_RE.finditer(head)]
    scripts += [transform_script(m) for m in SCRIPT_RE.finditer(body)]
    return static + "\n" + "\n".join(scripts) + "\n"


# --- main ----------------------------------------------------------------------------------------

def main(argv):
    artifact = "--artifact" in argv
    unknown = [a for a in argv if a != "--artifact"]
    if unknown:
        if any(a in ("-h", "--help") for a in unknown):
            print(__doc__.strip())
            return 0
        raise BuildError("unknown argument(s): %s (only --artifact is accepted)" % " ".join(unknown))

    index = os.path.join(ROOT, "index.html")
    if not os.path.isfile(index):
        raise BuildError("missing %s" % index)
    with open(index, "r", encoding="utf-8") as f:
        html = f.read()

    missing = [r for r in local_refs(html) if not os.path.isfile(local_path(r))]
    if missing:
        sys.stderr.write("bundle.py: %d local file(s) referenced by index.html are missing:\n" % len(missing))
        for r in missing:
            sys.stderr.write("  %s\n" % r)
        sys.stderr.write("Nothing was written. Create them (an owner that needs no CSS still writes a "
                         "comment-only file) and run again.\n")
        return 1

    out = build_artifact(html) if artifact else build_local(html)
    data = out.encode("utf-8")
    os.makedirs(DIST_DIR, exist_ok=True)
    out_path = os.path.join(DIST_DIR, "marginalia-artifact.html" if artifact else "marginalia.html")
    with open(out_path, "wb") as f:
        f.write(data)

    size = len(data)
    print("wrote %s: %s bytes (%.2f MB)" % (rel_to_root(out_path), "{:,}".format(size), size / 1048576.0))
    print("  inlined %d local stylesheet(s), %d local script(s); %d CDN stylesheet(s) inlined with %d font(s) "
          "embedded; %d download(s), %d from cache" % (STATS["styles"], STATS["scripts"], STATS["remote_styles"],
                                                       STATS["fonts"], STATS["downloads"], STATS["cached"]))
    if size > MAX_BYTES:
        sys.stderr.write("bundle.py: %s is %s bytes, above the 15 MB limit (%s)\n"
                         % (rel_to_root(out_path), "{:,}".format(size), "{:,}".format(MAX_BYTES)))
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BuildError as e:
        sys.stderr.write("bundle.py: error: %s\n" % e)
        sys.exit(1)

# SELF-CHECK (SPEC §18 "Bundler", BUILD-NOTES "Artifact page contract"): local build inlines every local
# <link rel=stylesheet> and <script src="js/…"> in document order (</style, </script escaped) and keeps CDN
# tags; --artifact emits the fragment (title, Google Fonts link, katex CSS with data: fonts, local styles,
# build meta "artifact", #app markup, cdnjs scripts, worker script, inlined local scripts, boot script);
# tools/.cache/ keyed by a safe file name; missing local files listed and exit 1; byte size printed, exit 1
# above 15 MB; python3 -I, stdlib only.
