"""Turn an AI-generated floor image into a seamless square tile.

Usage: python3 scripts/art/make_floor.py RAW.png OUT.png [size]

Center-crops to a square, resizes, then cross-fades the tile with a copy
shifted by half its size so opposite edges match when tiled. The corner
watermark is cropped away by the square crop's inset.
"""
import sys

import numpy as np
from PIL import Image

INSET = 0.06  # crop margin, removes edge vignetting and the corner watermark


def make_floor(src: str, dst: str, size: int = 512) -> None:
    img = Image.open(src).convert("RGB")
    w, h = img.size
    side = int(min(w, h) * (1 - 2 * INSET))
    left, top = (w - side) // 2, (h - side) // 2
    tile = np.asarray(img.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS), dtype=float)
    shifted = np.roll(tile, (size // 2, size // 2), axis=(0, 1))
    # weight is 1 in the middle of the tile and 0 at its edges, so the edges come from `shifted`,
    # whose edges are the original's continuous centre
    ramp = 1 - np.abs(np.linspace(-1, 1, size))
    weight = np.clip(np.minimum.outer(ramp, ramp) * 2.5, 0, 1)[..., None]
    out = tile * weight + shifted * (1 - weight)
    Image.fromarray(out.astype(np.uint8)).save(dst, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    make_floor(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 512)
