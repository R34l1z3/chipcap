#!/usr/bin/env python3
# ============================================================
# scripts/subset-zpix.py — subset the 7 MB Zpix CJK pixel font down to
# only the glyphs used in the Chinese translation (src/i18n/locales/zh.json).
#
# Re-run after expanding zh strings:
#   1. download Zpix.ttf once (GitHub release v3.1.11) to ZPIX_SRC
#   2. python scripts/subset-zpix.py
# Output: public/fonts/zpix-subset.woff2 (tens of KB), referenced by the
# @font-face in src/index.css (font-family 'Zpix').
# ============================================================

import json, os
from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZPIX_SRC = os.environ.get("ZPIX_SRC", "C:/Temp/zpix/Zpix.ttf")
ZH_JSON  = os.path.join(ROOT, "src", "i18n", "locales", "zh.json")
OUT      = os.path.join(ROOT, "public", "fonts", "zpix-subset.woff2")

# Collect every char that appears anywhere in zh.json.
chars = set()
def walk(o):
    if isinstance(o, str):
        chars.update(o)
    elif isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
with open(ZH_JSON, encoding="utf-8") as f:
    walk(json.load(f))

# Keep CJK + CJK punctuation (Latin/digits render in Press Start 2P).
cjk = sorted(c for c in chars if ord(c) >= 0x2E80)
text = "".join(cjk)
print(f"unique CJK glyphs: {len(cjk)}")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
args = [
    ZPIX_SRC,
    f"--text={text}",
    f"--output-file={OUT}",
    "--flavor=woff2",
    "--no-hinting",
    "--desubroutinize",
    "--drop-tables+=DSIG",
]
subset.main(args)
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")
