#!/usr/bin/env python3
"""make_icons.py — cut Goose's three app icons from his helmet picture, and check them.

What it is for: the mark is the fighter pilot's helmet he made in Gemini on 11-01
(Goose is the man in the right seat). It is cut from his picture the way Atlas's
badge was, crop and resize, never redrawn. The picture stays out of this public
repo, at ~/Goose/design/goose-helmet-gemini.jpeg (his download,
Gemini_Generated_Image_rx7jeurx7jeurx7j.jpeg; a copy sits in Drive's
Operations/Marketing beside the Atlas and Forge art).

  icons/icon-192.png            purpose "any": his tile, glow line and all, the corners cut clear
  icons/icon-512.png            purpose "any": the same, at 512
  icons/icon-maskable-512.png   purpose "maskable", full bleed, so Android's mask never clips
                                the helmet: the whole helmet sits inside the inner 80% safe
                                circle, and his blue panel fades into its own colour, carried
                                out to the edges and darkening to his picture's navy

--check reads every shipped icon back and refuses (exit 1) if a size or the PNG
format is wrong, if the tile's corners are not clear or its glow line is gone, if
the maskable tile has a see-through pixel, if any of the helmet reaches past the
safe circle, or if the gold visor is missing (the sign his picture never made it in).

How: --render needs PIL and numpy (his python has both). --check is the standard
library alone: a real PNG reader below, so the suite runs it anywhere.

Usage:
  python3 tools/make_icons.py --render     cut the three PNGs into shell/icons/
  python3 tools/make_icons.py --check      read the shipped icons back and check them; writes nothing

After a new picture: re-measure the boxes below, render, check, then bump CACHE in
sw.js, or a phone keeps the old icon.
"""
import math
import os
import struct
import sys
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "icons"
PICTURE = Path(__file__).resolve().parents[2] / "design" / "goose-helmet-gemini.jpeg"

# (file name, size, maskable)
JOBS = (
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
)

# Where things sit in his picture, measured once by eye and by pixel.
PICTURE_SIZE = (2752, 1536)
TILE = (745, 135, 2007, 1397)       # the tile's outer edge, glow line included
TILE_RADIUS = 0.235                 # its corner, as a share of its side
PANEL = (792, 178, 1960, 1365)      # the blue panel inside the glow line's bevel
PANEL_RADIUS = 235                  # the panel's corner, picture px
HELMET = (1277, 825, 619)           # the smallest circle holding the whole helmet: x, y, radius
FIT = 0.39                          # that circle's radius in the maskable icon, as a share of its side
EDGE = 45                           # where the panel ends, the helmet (its hose) fades over this, picture px
FADE = 150                          # the panel's grid fades into the field over this, picture px

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


def is_gold(r, g, b):
    """The visor's gold: red far above blue. His blue panel and the grey helmet never are."""
    return r - b > 40


def is_helmet(r, g, b):
    """Grey, black or gold against his blue: the helmet. The panel, its grid and the navy all run blue."""
    return b - r < 22


def judge(name, size, maskable, data):
    """Every check one icon must pass. Returns a list of problems (empty = good)."""
    try:
        w, h, rows = decode_png(data)
    except Exception as e:                        # a broken file is a finding, not a crash
        return [f"{name}: {e}"]
    if (w, h) != (size, size):
        return [f"{name}: is {w}x{h}, not {size}x{size}"]
    problems = []
    corners = [rows[y][x * 4 + 3] for y in (0, size - 1) for x in (0, size - 1)]
    if maskable:
        see_through = sum(1 for row in rows for a in row[3::4] if a != 255)
        if see_through:
            problems.append(f"{name}: {see_through} see-through pixels; a maskable tile runs to every edge")
    else:
        if any(corners):
            problems.append(f"{name}: the tile's corners must be clear (corner alpha {corners})")
        if rows[size // 2][(size // 2) * 4 + 3] != 255:
            problems.append(f"{name}: the tile's middle must be solid")
        band, m = max(2, round(size * 0.06)), size // 2
        sides = {"left": [(i, m) for i in range(band)], "right": [(size - 1 - i, m) for i in range(band)],
                 "top": [(m, i) for i in range(band)], "bottom": [(m, size - 1 - i) for i in range(band)]}
        for side, pts in sides.items():
            if max(rows[y][x * 4 + 2] for x, y in pts) < 200:
                problems.append(f"{name}: no glow line along the tile's {side} edge; it is not his tile")
    c, limit = size / 2.0, SAFE_RADIUS * size
    gold = outside = 0
    for y, row in enumerate(rows):
        for x in range(size):
            r, g, b, a = row[x * 4:x * 4 + 4]
            if not a:
                continue
            if is_gold(r, g, b):
                gold += 1
            if maskable and is_helmet(r, g, b) and math.hypot(x + 0.5 - c, y + 0.5 - c) > limit:
                outside += 1
    if outside:
        problems.append(f"{name}: {outside} pixels of helmet outside the safe circle; the mask would clip it")
    if gold < size * size * 0.01:
        problems.append(f"{name}: hardly any gold; the visor is missing, so his picture is not in it")
    return problems


def imaging():
    """PIL and numpy, for --render only."""
    try:
        import numpy as np
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        die("--render needs PIL and numpy for this python; --check does not")
    return np, Image, ImageDraw, ImageFilter


def smooth(t):
    np = imaging()[0]
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def rounded_alpha(w, h, radius, feather):
    """1 inside a rounded rect, easing to 0 across `feather` px at its edge."""
    np = imaging()[0]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    qx = np.abs(x - (w - 1) / 2) - (w / 2 - radius)
    qy = np.abs(y - (h - 1) / 2) - (h / 2 - radius)
    d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
    return smooth(-d / max(feather, 1e-6))


def blur(arr, radius):
    np, Image, _, ImageFilter = imaging()
    img = Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), np.float32)


def push_pull(rgb, known):
    """Fill the unknown pixels from what surrounds them (a pyramid fill)."""
    np, Image, _, _ = imaging()
    levels = []
    p, w = rgb * known[..., None], known
    while min(w.shape) > 2:
        levels.append((p, w))
        h2, w2 = (w.shape[0] + 1) // 2, (w.shape[1] + 1) // 2
        pp = np.zeros((h2 * 2, w2 * 2, 3), np.float32)
        pp[:p.shape[0], :p.shape[1]] = p
        ww = np.zeros((h2 * 2, w2 * 2), np.float32)
        ww[:w.shape[0], :w.shape[1]] = w
        p = pp.reshape(h2, 2, w2, 2, 3).mean(axis=(1, 3))
        w = ww.reshape(h2, 2, w2, 2).mean(axis=(1, 3))
    c = p / np.maximum(w, 1e-6)[..., None]
    for p, w in reversed(levels):
        up = np.stack([np.asarray(Image.fromarray(c[..., i]).resize((w.shape[1], w.shape[0]), Image.BILINEAR))
                       for i in range(3)], -1)
        c = p + up * (1 - np.clip(w, 0, 1)[..., None])
    return c


def tile_icon(picture, size):
    """His tile as Gemini drew it, cropped and resized, the corners outside it cut clear."""
    _, Image, ImageDraw, _ = imaging()
    tile = picture.crop(TILE).resize((size, size), Image.LANCZOS).convert("RGBA")
    edge = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(edge).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1),
                                           radius=TILE_RADIUS * size * 4, fill=255)
    tile.putalpha(edge.resize((size, size), Image.LANCZOS))
    return tile


def maskable_icon(picture, size):
    """His panel, scaled so the whole helmet fits the safe circle, on its own colour carried to the edges."""
    np, Image, _, ImageFilter = imaging()
    s = FIT * size / HELMET[2]                    # icon px per picture px
    panel = picture.crop(PANEL)
    pw, ph = panel.size
    fw, fh = round(pw * s), round(ph * s)
    ox = round(size / 2 + (PANEL[0] - HELMET[0]) * s)
    oy = round(size / 2 + (PANEL[1] - HELMET[1]) * s)
    if ox < 0 or oy < 0 or ox + fw > size or oy + fh > size:
        die("the panel no longer fits inside the maskable icon; re-measure HELMET or lower FIT")
    arr = np.asarray(panel, np.float32)
    inside = rounded_alpha(pw, ph, PANEL_RADIUS, 1) > 0.5
    grey = ((arr[..., 2] - arr[..., 0]) < 22) & inside      # is_helmet, over the whole panel
    # the field: the panel with the helmet lifted out, filled from around it, softened
    lifted = np.asarray(Image.fromarray((grey * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(15))) > 0
    field = blur(push_pull(arr, (inside & ~lifted).astype(np.float32)), 25)
    ring = inside & ~(rounded_alpha(pw, ph, PANEL_RADIUS, 40) > 0.99)
    rim = field[ring].mean(axis=0)
    navy = np.concatenate([np.asarray(picture.crop((0, 0, 600, PICTURE_SIZE[1])), np.float32).reshape(-1, 3),
                           np.asarray(picture.crop((PICTURE_SIZE[0] - 600, 0) + PICTURE_SIZE), np.float32)
                           .reshape(-1, 3)]).mean(axis=0)
    # the background: the field carried past the panel's edge, settling to its rim colour, then to his navy
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    fx = np.clip(HELMET[0] - PANEL[0] + (xx + 0.5 - size / 2) / s, 0, pw - 1).astype(int)
    fy = np.clip(HELMET[1] - PANEL[1] + (yy + 0.5 - size / 2) / s, 0, ph - 1).astype(int)
    away = np.hypot(np.maximum(np.maximum(ox - xx, xx - (ox + fw)), 0),
                    np.maximum(np.maximum(oy - yy, yy - (oy + fh)), 0))
    u = smooth(away / (0.12 * size))[..., None]
    bg = blur(field[fy, fx] * (1 - u) + rim * u, size / 32)
    t = 0.55 * smooth((np.hypot(xx + 0.5 - size / 2, yy + 0.5 - size / 2) / size - 0.30) / 0.41)[..., None]
    bg = bg * (1 - t) + navy * t
    # the panel itself, sharp: its grid fades into the field; the helmet stays solid except where the panel ends
    helmet = np.asarray(Image.fromarray((grey * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(6))) > 0
    helmet = Image.fromarray((helmet * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4))
    helmet = np.asarray(helmet.resize((fw, fh), Image.LANCZOS), np.float32) / 255
    alpha = np.maximum(rounded_alpha(fw, fh, PANEL_RADIUS * s, FADE * s),
                       helmet * rounded_alpha(fw, fh, PANEL_RADIUS * s, EDGE * s))[..., None]
    fore = np.asarray(panel.resize((fw, fh), Image.LANCZOS), np.float32)
    bg[oy:oy + fh, ox:ox + fw] = fore * alpha + bg[oy:oy + fh, ox:ox + fw] * (1 - alpha)
    return Image.fromarray(np.clip(bg + 0.5, 0, 255).astype(np.uint8)).convert("RGBA")


def render(icon_dir):
    _, Image, _, _ = imaging()
    if not PICTURE.is_file():
        die(f"{PICTURE} is missing; nothing rendered")
    picture = Image.open(PICTURE).convert("RGB")
    if picture.size != PICTURE_SIZE:
        die(f"{PICTURE.name} is {picture.size[0]}x{picture.size[1]}, not "
            f"{PICTURE_SIZE[0]}x{PICTURE_SIZE[1]}: a new picture, so re-measure the boxes first")
    for name, size, maskable in JOBS:
        img = maskable_icon(picture, size) if maskable else tile_icon(picture, size)
        out = icon_dir / name
        tmp_out = out.with_suffix(".tmp.png")
        img.save(tmp_out, format="PNG", optimize=True)
        problems = judge(name, size, maskable, tmp_out.read_bytes())
        if problems:
            tmp_out.unlink()
            die("; ".join(problems))
        os.replace(tmp_out, out)
        print(f"  {name:<24} {size}x{size}  {'maskable' if maskable else 'any'}", flush=True)
    print(f"{len(JOBS)} icons cut from {PICTURE.name} into {icon_dir}. Bump CACHE in sw.js so phones take them.")


def check(icon_dir):
    problems = []
    for name, size, maskable in JOBS:
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
