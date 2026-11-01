#!/usr/bin/env python3
"""make_icons.py — render Goose's three app icons from the helmet, and check them.

What it is for: the mark is a fighter pilot's helmet (his 11-01 call: Goose is
the man in the right seat), drawn in gold on the dark tile, the one lit thing
in a dark cab. The drawing lives in two SVGs; three files come out of them:

  icons/goose.svg               the helmet on a rounded dark tile, transparent corners
  icons/goose-maskable.svg      the same helmet on a tile that runs to every edge,
                                the whole mark inside the inner 80% safe circle

  icons/icon-192.png            purpose "any", from goose.svg
  icons/icon-512.png            purpose "any", from goose.svg
  icons/icon-maskable-512.png   purpose "maskable", from goose-maskable.svg, so
                                Android's mask never clips the helmet

Nothing gold is drawn in the top-right corner: that is where the launcher puts
its badge. --check reads every shipped icon back and refuses (exit 1) if gold
ever reaches there, if a maskable icon's gold leaves the safe circle, or if a
tile's corners are wrong.

How: --render draws each SVG at its exact pixel size with headless Chrome (a
throwaway profile, so no window shows and his own browser is never touched;
the same way Almanac's tools/build_icons.py renders), then PIL writes it back
as 8-bit RGBA. --check is the standard library alone: a real PNG reader below.

Usage:
  python3 tools/make_icons.py --render     render the three PNGs into shell/icons/
  python3 tools/make_icons.py --check      read the shipped icons back and check them; writes nothing

After a change to the mark, bump CACHE in sw.js, or a phone keeps the old icon.
"""
import math
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "icons"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# (file name, size, maskable, the SVG it is drawn from)
JOBS = (
    ("icon-192.png", 192, False, "goose.svg"),
    ("icon-512.png", 512, False, "goose.svg"),
    ("icon-maskable-512.png", 512, True, "goose-maskable.svg"),
)

# The badge box: the top-right fifth of the canvas, each way. No gold there.
BADGE_BOX = 0.20
# Android crops a maskable icon to shapes no smaller than this circle.
SAFE_RADIUS = 0.40


def die(msg):
    """Loud and non-zero: a renderer that fails quietly ships yesterday's icon."""
    print(f"make_icons: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def decode_png(data):
    """Read an 8-bit RGBA PNG: (width, height, rows of RGBA bytes).

    A real reader, not a trust: it checks the signature, every CRC, the
    header, and undoes filters 0 to 4, so --check can judge any 8-bit RGBA PNG.
    """
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width = 8, b"", None
    height = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        tag, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        (crc,) = struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])
        if zlib.crc32(tag + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"bad CRC in {tag!r}")
        if tag == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, ctype, interlace) != (8, 6, 0):
                raise ValueError("not 8-bit RGBA, non-interlaced")
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + n
    if width is None:
        raise ValueError("no IHDR")
    raw = zlib.decompress(idat)
    stride = width * 4
    if len(raw) != height * (stride + 1):
        raise ValueError("pixel data is the wrong length")
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else b if pb <= pc else c
                line[i] = (line[i] + pr) & 0xFF
            elif f != 0:
                raise ValueError(f"unknown filter {f}")
        rows.append(bytes(line))
        prev = line
    return width, height, rows


def warmth(r, g, b, a):
    """How gold a pixel is: gold has red far above blue; the dark tile and greys do not.
    Above 4 is any trace of gold (even a faint edge); above 40 is the mark itself."""
    return r - b if a else 0


def is_gold(r, g, b, a):
    return warmth(r, g, b, a) > 40


def judge(name, size, maskable, data):
    """Every check one icon must pass. Returns a list of problems (empty = good)."""
    try:
        w, h, rows = decode_png(data)
    except Exception as e:                        # a broken file is a finding, not a crash
        return [f"{name}: {e}"]
    problems = []
    if (w, h) != (size, size):
        problems.append(f"{name}: is {w}x{h}, not {size}x{size}")
        return problems
    box = int(size * BADGE_BOX)
    for y in range(box):
        row = rows[y]
        for x in range(size - box, size):
            if warmth(*row[x * 4:x * 4 + 4]) > 4:
                problems.append(f"{name}: gold in the badge corner at ({x},{y})")
                return problems
    corner_alpha = rows[0][3]
    if maskable and corner_alpha != 255:
        problems.append(f"{name}: a maskable tile must run to the edges (corner alpha {corner_alpha})")
    if not maskable and corner_alpha != 0:
        problems.append(f"{name}: the tile's corners must be transparent (corner alpha {corner_alpha})")
    c, limit = size / 2.0, SAFE_RADIUS * size + 1.0
    gold = 0
    for y, row in enumerate(rows):
        for x in range(size):
            if is_gold(*row[x * 4:x * 4 + 4]):
                gold += 1
                if maskable and math.hypot(x + 0.5 - c, y + 0.5 - c) > limit:
                    problems.append(f"{name}: gold outside the safe circle at ({x},{y})")
                    return problems
    if gold < size * size * 0.05:
        problems.append(f"{name}: hardly any gold; the helmet is missing")
    return problems


def render_one(svg, size, out):
    """Draw one SVG at exactly size x size with headless Chrome, written as 8-bit RGBA."""
    try:
        from PIL import Image
    except ImportError:
        die("--render needs PIL for this python; --check does not")
    if not os.path.exists(CHROME):
        die(f"--render needs Google Chrome at {CHROME}")
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text("<!doctype html><meta charset=utf-8><style>html,body{margin:0;"
                        "background:transparent}svg{display:block;width:%dpx;height:%dpx}</style>%s"
                        % (size, size, svg.read_text()))
        shot = Path(tmp) / "shot.png"
        r = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            f"--user-data-dir={Path(tmp) / 'profile'}",
                            "--default-background-color=00000000",
                            f"--window-size={size},{size}", f"--screenshot={shot}", page.as_uri()],
                           capture_output=True, text=True, timeout=90)
        if r.returncode != 0 or not shot.is_file():
            die(f"Chrome could not draw {svg.name} at {size}: {r.stderr.strip()[-300:]}")
        img = Image.open(shot).convert("RGBA")
        if img.size != (size, size):
            die(f"Chrome drew {svg.name} at {img.size}, not {size}x{size}")
        tmp_out = out.with_suffix(".tmp.png")
        img.save(tmp_out, format="PNG", optimize=True)
        os.replace(tmp_out, out)


def render(icon_dir):
    for name, size, maskable, src in JOBS:
        svg = icon_dir / src
        if not svg.is_file():
            die(f"{svg} is missing; nothing rendered")
        render_one(svg, size, icon_dir / name)
        problems = judge(name, size, maskable, (icon_dir / name).read_bytes())
        if problems:
            die("; ".join(problems))
        print(f"  {name:<24} {size}x{size}  from {src}", flush=True)
    print(f"{len(JOBS)} icons rendered into {icon_dir}. Bump CACHE in sw.js so phones take them.")


def check(icon_dir):
    problems = []
    for name, size, maskable, src in JOBS:
        if not (icon_dir / src).is_file():
            problems.append(f"{src}: missing (the drawing {name} comes from)")
        path = icon_dir / name
        if not path.is_file():
            problems.append(f"{name}: missing")
            continue
        problems.extend(judge(name, size, maskable, path.read_bytes()))
    if problems:
        die("; ".join(problems))
    print(f"{len(JOBS)} icons in {icon_dir} check out.")


def main(argv):
    if argv == ["--render"]:
        return render(ICONS)
    if argv == ["--check"]:
        return check(ICONS)
    die("usage: make_icons.py --render | --check")


if __name__ == "__main__":
    main(sys.argv[1:])
