#!/usr/bin/env python3
"""make_icons.py — cut Goose's three app icons with the standard library alone.

What it is for: the mark is the key. A dark tile with one warm gold ring, the
way the key on the page is the one lit thing in a dark cab. Three files come
out of the one drawing:

  icons/icon-192.png            purpose "any": a rounded dark tile, transparent corners
  icons/icon-512.png            the same at 512
  icons/icon-maskable-512.png   purpose "maskable": the tile runs to every edge and
                                the ring sits inside the inner 80% safe circle, so
                                Android's mask never clips it

Nothing is drawn in the top-right corner: that is where the launcher puts its
badge. The tool checks that on every file it writes, and refuses (exit 1) if
gold ever reaches there.

What it never does: no PIL, no Chrome, no network, and it writes nowhere but
the icons folder (or the --out folder you name). Almanac's tools/build_icons.py
renders an SVG through headless Chrome and PIL; Goose's SPEC asks for a stdlib
cutter, so the ring is drawn here from its own geometry, anti-aliased by
signed distance.

Usage:
  python3 tools/make_icons.py              cut into shell/icons/
  python3 tools/make_icons.py --out DIR    cut into DIR instead (the shell test uses a temp folder)
  python3 tools/make_icons.py --check      read the shipped icons back and check them; writes nothing

After a change to the mark, bump CACHE in sw.js, or a phone keeps the old icon.
"""
import math
import os
import struct
import sys
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "icons"

# BMH tokens (bik/design/themes/bmh.css): --color-bg, --color-primary-bright,
# --color-primary, and a deeper gold for the ring's lower edge, where a lit
# glass ring falls into shadow.
TILE = (15, 15, 15)
BRIGHT = (251, 191, 36)
GOLD = (229, 181, 36)
DEEP = (201, 150, 26)

# (file name, size, maskable)
JOBS = (
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
)

# The badge box: the top-right fifth of the canvas, each way. No gold there.
BADGE_BOX = 0.20


def die(msg):
    """Loud and non-zero: a cutter that fails quietly ships yesterday's icon."""
    print(f"make_icons: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def over(src, alpha, dst):
    """Paint src over an opaque dst at this alpha (straight colour, sRGB)."""
    return tuple(s * alpha + d * (1.0 - alpha) for s, d in zip(src, dst))


def ring_colour(t):
    """Top of the ring catches the light (t=0); the bottom falls into shadow (t=1)."""
    if t < 0.5:
        k = t / 0.5
        return tuple(a + (b - a) * k for a, b in zip(BRIGHT, GOLD))
    k = (t - 0.5) / 0.5
    return tuple(a + (b - a) * k for a, b in zip(GOLD, DEEP))


def tile_cover(px, py, s, radius):
    """How much of this pixel the rounded square covers (a signed-distance box)."""
    half = s / 2.0
    qx = abs(px - half) - (half - radius)
    qy = abs(py - half) - (half - radius)
    dist = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius
    return clamp(0.5 - dist)


def render(size, maskable):
    """Rows of RGBA bytes for one icon."""
    s = float(size)
    c = s / 2.0
    # The maskable ring is drawn at 80% of the "any" ring, so after the
    # launcher's mask crops to the safe circle the two read the same size.
    scale = 0.8 if maskable else 1.0
    r_mid, thick = 0.29 * s * scale, 0.058 * s * scale
    r_in, r_out = r_mid - thick / 2.0, r_mid + thick / 2.0
    halo = 0.065 * s * scale
    corner = 0.2237 * s
    rows = []
    for y in range(size):
        py = y + 0.5
        row = bytearray(size * 4)
        for x in range(size):
            px = x + 0.5
            cover = 1.0 if maskable else tile_cover(px, py, s, corner)
            if cover <= 0.0:
                continue                         # outside the tile: transparent
            col = TILE
            d = math.hypot(px - c, py - c)
            if d < r_in:
                # warm light pooled inside the ring, brightest at the centre
                k = 1.0 - d / r_in
                col = over(GOLD, 0.16 * k * k, col)
            elif d > r_out and d - r_out < halo:
                # the glow just outside the ring, fading smoothly to nothing
                x01 = (d - r_out) / halo
                col = over(GOLD, 0.24 * math.exp(-3.0 * x01) * (1.0 - x01) ** 2, col)
            ring = clamp(min(d - r_in, r_out - d) + 0.5)
            if ring > 0.0:
                t = clamp((py - (c - r_out)) / (2.0 * r_out))
                col = over(ring_colour(t), ring, col)
            i = x * 4
            row[i] = int(round(col[0]))
            row[i + 1] = int(round(col[1]))
            row[i + 2] = int(round(col[2]))
            row[i + 3] = int(round(255 * cover))
        rows.append(bytes(row))
    return rows


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(size, rows):
    """An 8-bit RGBA PNG. Rows use the Up filter (a smooth drawing packs small)."""
    out = bytearray()
    prev = bytes(size * 4)
    for row in rows:
        out.append(2)                            # filter type 2: Up
        out.extend((a - b) & 0xFF for a, b in zip(row, prev))
        prev = row
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b""))


def decode_png(data):
    """Read back what encode_png wrote: (width, height, rows of RGBA bytes).

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


def judge(name, size, data):
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
            r, g, b, a = row[x * 4:x * 4 + 4]
            if a and r - b > 4:                   # gold has red far above blue; the tile does not
                problems.append(f"{name}: gold in the badge corner at ({x},{y})")
                return problems
    mid = rows[size // 2]
    lit = sum(1 for x in range(size) if mid[x * 4] - mid[x * 4 + 2] > 120)
    if lit < 2:
        problems.append(f"{name}: no ring across the middle row")
    return problems


def write_atomic(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def cut(out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in JOBS:
        data = encode_png(size, render(size, maskable))
        problems = judge(name, size, data)
        if problems:
            die("; ".join(problems) + " — nothing written for it")
        write_atomic(out_dir / name, data)
        print(f"  {name:<24} {size}x{size}  {len(data):>7} bytes", flush=True)
    print(f"{len(JOBS)} icons cut into {out_dir}. Bump CACHE in sw.js so phones take them.")


def check(icon_dir):
    problems = []
    for name, size, _ in JOBS:
        path = icon_dir / name
        if not path.is_file():
            problems.append(f"{name}: missing")
            continue
        problems.extend(judge(name, size, path.read_bytes()))
    if problems:
        die("; ".join(problems))
    print(f"{len(JOBS)} icons in {icon_dir} check out.")


def main(argv):
    if not argv:
        return cut(ICONS)
    if argv == ["--check"]:
        return check(ICONS)
    if len(argv) == 2 and argv[0] == "--out":
        return cut(Path(argv[1]).expanduser().resolve())
    die("usage: make_icons.py [--out DIR | --check]")


if __name__ == "__main__":
    main(sys.argv[1:])
