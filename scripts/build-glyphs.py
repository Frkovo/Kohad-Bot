"""Bake the B50 fonts (assets/font-src/) into random-access glyph stores (assets/fonts/glyphs-{regular,bold}.bin).

The renderer lays text out itself and draws each glyph as a cached <path>, so it needs only advances and
outlines, read on demand. Fallback order is baked in: M+ Rounded subset first, then full Noto Sans CJK SC.
Only the .bin stores are deployed; the font sources stay local.

Run after changing fonts:  python scripts/build-glyphs.py   (needs `pip install fonttools`)

Format (little-endian): b"GLY1", u32 count, u32 unitsPerEm,
  u32 codepoints[count] (ascending), u16 advances[count], u32 offsets[count + 1], then the blob:
  each glyph's SVG path data (font units, y down, integer coordinates), raw-deflated.
"""
import struct
import sys
import zlib
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SOURCES, FONTS = ASSETS / "font-src", ASSETS / "fonts"
STORES = {
    "regular": ["MPlusRounded1c-Sub-Medium.ttf", "NotoSansCJKsc-Regular.otf"],
    "bold": ["MPlusRounded1c-Sub-Bold.ttf", "NotoSansCJKsc-Bold.otf"],
}


def build(name, files):
    fonts = [TTFont(SOURCES / f, lazy=True) for f in files]
    upm = fonts[0]["head"].unitsPerEm
    if any(f["head"].unitsPerEm != upm for f in fonts):
        sys.exit("all fonts in a store must share unitsPerEm")
    chosen = {}
    for font in fonts:
        for cp, glyph_name in font.getBestCmap().items():
            chosen.setdefault(cp, (font, glyph_name))
    codepoints = sorted(chosen)
    advances, offsets, blob = [], [0], bytearray()
    glyph_sets = {id(f): f.getGlyphSet() for f in fonts}
    for cp in codepoints:
        font, glyph_name = chosen[cp]
        glyph_set = glyph_sets[id(font)]
        svg = SVGPathPen(glyph_set, ntos=lambda v: str(round(v)))
        glyph_set[glyph_name].draw(TransformPen(svg, (1, 0, 0, -1, 0, 0)))
        advances.append(font["hmtx"][glyph_name][0])
        deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
        blob += deflate.compress(svg.getCommands().encode()) + deflate.flush()
        offsets.append(len(blob))
    FONTS.mkdir(exist_ok=True)
    out = FONTS / f"glyphs-{name}.bin"
    with open(out, "wb") as f:
        f.write(b"GLY1" + struct.pack("<II", len(codepoints), upm))
        f.write(struct.pack(f"<{len(codepoints)}I", *codepoints))
        f.write(struct.pack(f"<{len(codepoints)}H", *advances))
        f.write(struct.pack(f"<{len(offsets)}I", *offsets))
        f.write(blob)
    print(f"{out.name}: {len(codepoints)} glyphs, {out.stat().st_size / 1e6:.1f} MB")


for name, files in STORES.items():
    build(name, files)
