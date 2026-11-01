#!/usr/bin/env python3
"""test_shell.py — the shell's rules, checked without a browser.

What it is for: the phone page has hard rules from docs/SPEC.md (SHELL) and
this build has no browser check, so every rule that can be read from the files
is read here, and the behaviour is walked in Node by tools/smoke.js:

  - the CSP meta is the SPEC's, byte for byte (read from the SPEC itself);
  - no inline script, inline style or inline handler, and no <form>;
  - no innerHTML, outerHTML, insertAdjacentHTML or document.write anywhere;
  - every id app.js reaches for exists in index.html, once;
  - the 988 button sits in the top bar, outside every screen, and dials as a
    plain tel: link even with no script;
  - the sponsor's number is touched only inside its fenced section, which
    never calls the network;
  - the manifest, the icons and the service worker match the SPEC;
  - buttons are 44 px or more, the key is at least 44% of a portrait phone's
    width, and reduced motion stills everything.

What it never does: no network, no browser, nothing written outside a temp
folder. It never imports goose; GOOSE_DATA is pointed at a temp folder anyway,
the house rule for every test file, so nothing this file grows into can ever
touch goose.db.

Run (Python 3.14): python3 shell/tools/test_shell.py
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ["GOOSE_DATA"] = tempfile.mkdtemp(prefix="goose-shell-test-")

SHELL = Path(__file__).resolve().parent.parent
SPEC = SHELL.parent / "docs" / "SPEC.md"
INDEX = (SHELL / "index.html").read_text()
APP = (SHELL / "app.js").read_text()
CSS = (SHELL / "app.css").read_text()
SW = (SHELL / "sw.js").read_text()
NODE = shutil.which("node") or "/opt/homebrew/bin/node"
PY = sys.executable


def spec_csp():
    """The CSP line exactly as the SPEC writes it, under 'The CSP meta'."""
    text = SPEC.read_text()
    at = text.index("**The CSP meta**")
    block = text[at:at + 600]
    m = re.search(r"```\s*\n\s*(default-src[^\n]*?)\s*\n\s*```", block)
    if not m:
        raise AssertionError("could not find the CSP line in docs/SPEC.md")
    return m.group(1).strip()


class Tree(HTMLParser):
    """Every element with its ancestors' ids and tags, and its attributes."""
    VOID = {"meta", "link", "input", "br", "img", "source", "path", "rect", "circle"}

    def __init__(self):
        super().__init__()
        self.stack, self.nodes = [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.nodes.append({"tag": tag, "attrs": a,
                           "path": [(t, x.get("id")) for t, x in self.stack]})
        if tag not in self.VOID and not tag.endswith("/"):
            self.stack.append((tag, a))

    def handle_startendtag(self, tag, attrs):
        self.nodes.append({"tag": tag, "attrs": dict(attrs),
                           "path": [(t, x.get("id")) for t, x in self.stack]})

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def tree():
    t = Tree()
    t.feed(INDEX)
    return t.nodes


def png_size(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name} is not a PNG"
    w, h = struct.unpack(">II", data[16:24])
    return w, h


class TestPage(unittest.TestCase):
    def test_csp_is_the_specs_exactly(self):
        metas = re.findall(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', INDEX)
        self.assertEqual(len(metas), 1, "exactly one CSP meta")
        self.assertEqual(metas[0], spec_csp())
        head = INDEX.split("</head>")[0]
        csp_at = head.index("Content-Security-Policy")
        for tag in ("<link", "<script"):
            self.assertLess(csp_at, head.index(tag), f"the CSP must come before the first {tag}")

    def test_no_inline_script_style_handler_or_form(self):
        for m in re.finditer(r"<script\b([^>]*)>", INDEX):
            self.assertIn("src=", m.group(1), "every script is a file")
        self.assertNotRegex(INDEX, r"<style\b")
        self.assertNotRegex(INDEX, r"\sstyle\s*=")
        self.assertNotRegex(INDEX, r"\son[a-z]+\s*=")
        # a <form> could put typed words, or the sponsor's number, into a URL if a script failed
        self.assertNotRegex(INDEX, r"<form\b")
        self.assertIn('href="app.css"', INDEX)
        self.assertIn('src="app.js"', INDEX)

    def test_no_markup_sinks_anywhere(self):
        for name, text in (("app.js", APP), ("sw.js", SW)):
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
                self.assertNotIn(sink, text, f"{name} uses {sink}")
        self.assertNotRegex(APP, r"setAttribute\(\s*['\"]style['\"]")
        self.assertNotIn("cssText", APP)

    def test_every_id_app_js_reaches_for_exists_once(self):
        ids = re.findall(r'\bid="([^"]+)"', INDEX)
        self.assertEqual(len(ids), len(set(ids)), "ids are unique")
        wanted = set(re.findall(r"\$\('([^']+)'\)", APP))
        wanted |= set(re.findall(r"(?:sheet|opener|title): '([^']+)'", APP))
        m = re.search(r"for \(const id of \[([^\]]+)\]\)", APP)
        self.assertIsNotNone(m)
        wanted |= set(re.findall(r"'([^']+)'", m.group(1)))
        missing = sorted(wanted - set(ids))
        self.assertEqual(missing, [], f"app.js reaches for ids index.html lacks: {missing}")
        self.assertGreater(len(wanted), 40)

    def test_988_is_in_the_top_bar_on_every_screen(self):
        nodes = tree()
        b = [n for n in nodes if n["attrs"].get("id") == "b988"]
        self.assertEqual(len(b), 1)
        b = b[0]
        self.assertEqual(b["attrs"].get("href"), "tel:988", "988 dials even if the script never loads")
        self.assertIn("aria-label", b["attrs"])
        ancestors = [i for _, i in b["path"]]
        self.assertIn("bar", ancestors)
        for screen in ("connect", "talk"):
            self.assertNotIn(screen, ancestors)
        bar = [n for n in nodes if n["attrs"].get("id") == "bar"][0]
        self.assertEqual(bar["tag"], "header")
        self.assertNotIn("hidden", bar["attrs"])
        self.assertEqual([i for _, i in bar["path"] if i], ["app"], "the bar rides over both screens")
        for screen in ("connect", "talk"):
            s = [n for n in nodes if n["attrs"].get("id") == screen][0]
            self.assertNotIn("bar", [i for _, i in s["path"]])
        # the bar sits above the scrim and every sheet, so a sheet never covers 988
        z = lambda sel: int(re.search(re.escape(sel) + r"\s*\{[^}]*?z-index:\s*(\d+)", CSS).group(1))
        self.assertGreater(z(".bar"), z(".sheet"))
        self.assertGreater(z(".bar"), z(".scrim"))
        # and the rail carries 988 call, 988 text, and the sponsor
        hrefs = {n["attrs"].get("id"): n["attrs"].get("href") for n in nodes}
        self.assertEqual(hrefs.get("call988"), "tel:988")
        self.assertEqual(hrefs.get("text988"), "sms:988")
        self.assertIn("sponsorLink", hrefs)
        self.assertIn("Open the connect link from the Mac.", INDEX)

    def test_buttons_have_labels_and_44px_targets(self):
        nodes = tree()
        buttons = [n for n in nodes if n["tag"] == "button"]
        self.assertGreater(len(buttons), 15)
        for n in buttons:
            self.assertIn("aria-label", n["attrs"], f"button without aria-label: {n['attrs'].get('id')}")
            self.assertEqual(n["attrs"].get("type"), "button")
        classes = set()
        for n in buttons:
            classes |= set((n["attrs"].get("class") or "").split())
        classes |= {"act", "rail-btn", "b988"}
        classes.discard("key")             # the key is var(--key) on both sides, far past 44 px
        for cls in sorted(classes):
            m = re.search(r"(?m)^\." + re.escape(cls) + r"\s*\{([^}]*)\}", CSS)
            self.assertIsNotNone(m, f"no rule for .{cls}")
            mh = re.search(r"min-height:\s*(\d+)px", m.group(1))
            self.assertIsNotNone(mh, f".{cls} has no min-height")
            self.assertGreaterEqual(int(mh.group(1)), 44, f".{cls} is under 44 px")
        self.assertIn("setAttribute('aria-label'", APP)   # app.js labels the buttons it makes

    def test_the_key_is_at_least_44_percent_of_a_portrait_phone(self):
        m = re.search(r"--key:\s*min\((\d+)vw,\s*(\d+)dvh\)", CSS)
        self.assertIsNotNone(m)
        vw, dvh = int(m.group(1)), int(m.group(2))
        # portrait phones from 360 px wide, keyboard down and keyboard up
        for w, h in ((360, 640), (360, 740), (384, 832), (393, 852), (412, 915), (430, 932),
                     (360, 420), (412, 480)):
            key = min(w * vw / 100, h * dvh / 100)
            self.assertGreaterEqual(key / w, 0.44, f"key is {key / w:.0%} of the width at {w}x{h}")

    def test_reduced_motion_stills_everything(self):
        m = re.search(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*)\}\s*$", CSS, re.S)
        self.assertIsNotNone(m)
        self.assertIn("animation: none !important", m.group(1))
        self.assertIn("transition: none !important", m.group(1))

    def test_no_horizontal_scroll(self):
        self.assertIn('content="width=device-width, initial-scale=1', INDEX)
        for sel in (".thread", ".sheet-body"):
            rule = re.search(re.escape(sel) + r"\s*\{([^}]*)\}", CSS).group(1)
            self.assertIn("overflow-x: hidden", rule, sel)
        self.assertRegex(CSS, r"body\s*\{[^}]*overflow: hidden")


class TestSponsor(unittest.TestCase):
    def test_the_number_is_touched_only_inside_its_section(self):
        start = APP.index("/* ══ THE SPONSOR'S NUMBER")
        end = APP.index("/* ══", start + 10)
        section = APP[start:end]
        self.assertEqual(APP.count("'goose.sponsor'"), 1, "the storage key is named once")
        decl = "const K_SPONSOR = 'goose.sponsor';"
        self.assertIn(decl, APP)
        outside = (APP[:start] + APP[end:]).replace(decl, "")
        self.assertNotIn("K_SPONSOR", outside, "the number's key is read outside its section")
        for word in ("fetch(", "call(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource",
                     "sessionStorage", "indexedDB", "document.cookie"):
            self.assertNotIn(word, section, f"the sponsor section uses {word}")
        # the functions that see the number are called only by wiring and the sheets
        for fn in ("sponsorGet()", "sponsorClean("):
            for m in re.finditer(re.escape(fn), outside):
                self.fail(f"{fn} used outside the sponsor section at {m.start()}")

    def test_the_sponsor_fields_never_feed_a_form_or_autofill(self):
        nodes = tree()
        for fid in ("sponsorIn", "setSponsor"):
            f = [n for n in nodes if n["attrs"].get("id") == fid][0]
            self.assertEqual(f["attrs"].get("type"), "tel")
            self.assertEqual(f["attrs"].get("autocomplete"), "off", "Chrome must not store it in autofill")
            self.assertNotIn("name", f["attrs"])
            self.assertNotIn("form", [t for t, _ in f["path"]])


class TestManifestIconsWorker(unittest.TestCase):
    def test_manifest(self):
        m = json.loads((SHELL / "manifest.webmanifest").read_text())
        self.assertEqual(m["id"], "/")
        self.assertEqual(m["start_url"], "./")
        self.assertEqual(m["scope"], "./")
        self.assertEqual(m["name"], "Goose")
        self.assertEqual(m["short_name"], "Goose")
        self.assertEqual(m["display"], "standalone")
        self.assertEqual(m["background_color"], "#0f0f0f")
        self.assertEqual(m["theme_color"], "#0f0f0f")
        got = {(i["sizes"], i["purpose"]): i["src"] for i in m["icons"]}
        self.assertEqual(set(got), {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")})
        for (sizes, _), src in got.items():
            w, h = png_size(SHELL / src)
            self.assertEqual(f"{w}x{h}", sizes, src)
        self.assertIn('<link rel="manifest" href="manifest.webmanifest">', INDEX)

    def test_icons_check_out_and_come_from_the_helmet(self):
        # the badge corner, the safe circle and the tile corners, read back from the PNGs
        r = subprocess.run([PY, str(SHELL / "tools" / "make_icons.py"), "--check"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        # the drawings the PNGs are rendered from ship with them, and load nothing
        for src in ("goose.svg", "goose-maskable.svg"):
            svg = (SHELL / "icons" / src).read_text()
            self.assertIn('viewBox="0 0 512 512"', svg, src)
            self.assertNotIn("<script", svg.lower(), src)
            self.assertNotRegex(svg, r"""(?i)(href|src)\s*=\s*["'](https?:|//)""",
                                f"{src} must load nothing from outside")

    def test_service_worker(self):
        # any version: every shell change bumps it, and the test must never stand in the way
        self.assertRegex(SW, r'const CACHE = "goose-shell-v\d+";')
        self.assertNotIn('const CACHE = "goose-shell-v1";', SW, "v1 is what phones already hold")
        listed = re.search(r"const SHELL = \[(.*?)\];", SW, re.S).group(1)
        files = set(re.findall(r'"\./([^"]*)"', listed))
        self.assertEqual(files, {"", "index.html", "app.js", "app.css", "manifest.webmanifest",
                                 "icons/icon-192.png", "icons/icon-512.png",
                                 "icons/icon-maskable-512.png"})
        for f in files - {""}:
            self.assertTrue((SHELL / f).is_file(), f"sw.js precaches a missing file: {f}")
        self.assertIn('fetch(u, { cache: "reload" })', SW)
        self.assertIn('u.pathname.indexOf("/api/") !== -1) return;', SW)
        self.assertIn("u.origin !== self.location.origin) return;", SW)
        self.assertIn('req.method !== "GET") return;', SW)
        self.assertIn("k.startsWith(PREFIX) && k !== CACHE", SW)
        self.assertIn("self.skipWaiting()", SW)
        self.assertIn("self.clients.claim()", SW)


class TestNode(unittest.TestCase):
    def node(self, *args):
        if not Path(NODE).exists():
            self.fail("node is not on this Mac: the shell's script checks cannot run")
        return subprocess.run([NODE, *args], capture_output=True, text=True, cwd=SHELL, timeout=180)

    def test_scripts_parse(self):
        for f in ("app.js", "sw.js", "tools/smoke.js"):
            r = self.node("--check", f)
            self.assertEqual(r.returncode, 0, f"{f}: {r.stderr}")

    def test_smoke_walks_every_path_green(self):
        r = self.node("tools/smoke.js")
        sys.stderr.write(r.stdout)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.strip().splitlines()[-1].startswith("SMOKE OK"))


if __name__ == "__main__":
    unittest.main()
