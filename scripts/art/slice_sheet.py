"""Slice an AI-generated asset sheet (items on a plain light background) into
transparent, trimmed sprites.

Usage: python3 scripts/art/slice_sheet.py SHEET.png OUT_DIR name1 name2 ...

The sheet is a grid with 3 items per row; each grid cell's foreground (after keying
out the background) is one item, named left-to-right, top-to-bottom. Specks and the
corner watermark are dropped.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

BG_TOLERANCE = 70      # max RGB distance from the sampled background colour
SPRITE_SIZE = 512      # longest side of the exported sprite
PAD = 8                # transparent padding around the trimmed sprite


def background_mask(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    corners = np.array([rgb[2, 2], rgb[2, w - 3], rgb[h - 3, 2], rgb[h - 3, w - 3]], dtype=float)
    bg = np.median(corners, axis=0)
    close = np.linalg.norm(rgb.astype(float) - bg, axis=2) < BG_TOLERANCE
    if bg[0] > 200 and bg[1] < 80 and bg[2] > 200:
        # magenta key colour never appears in the art, so key it everywhere (also inside rings)
        return close
    labels, _ = ndimage.label(close)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    border = border[border != 0]
    return np.isin(labels, border)


def despill_edges(rgb: np.ndarray, fg: np.ndarray, band: int = 4) -> np.ndarray:
    """Remove magenta key colour bleeding into the outer edge of each item."""
    edge = fg & ~ndimage.binary_erosion(fg, iterations=band)
    out = rgb.astype(int)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    spill = np.clip(np.minimum(r, b) - g, 0, None) * edge
    out[..., 0] = r - spill
    out[..., 2] = b - spill
    return np.clip(out, 0, 255).astype(np.uint8)


def slice_sheet(sheet: Path, out_dir: Path, names: list[str]) -> list[Path]:
    img = Image.open(sheet).convert("RGB")
    rgb = np.asarray(img)
    fg = ~background_mask(rgb)
    fg = ndimage.binary_opening(fg, iterations=2)
    labels, count = ndimage.label(fg)
    h, w = fg.shape
    band = 0.06
    for idx, sl in enumerate(ndimage.find_objects(labels), start=1):
        y0, y1, x0, x1 = sl[0].start / h, sl[0].stop / h, sl[1].start / w, sl[1].stop / w
        in_band = (y0 > 1 - band) or (y1 < band) or (x0 > 1 - band) or (x1 < band)
        if in_band or (labels[sl] == idx).sum() < 0.0004 * fg.size:
            fg[labels == idx] = False  # corner watermark and specks
    if len(names) % 3:
        raise SystemExit("sheet must be a grid with 3 items per row")
    rows = len(names) // 3
    # each grid cell is one item, so multi-piece items (confetti, sparkles) stay together
    labels = np.zeros(fg.shape, dtype=np.int32)
    regions = []
    for i in range(len(names)):
        r, c = divmod(i, 3)
        cell = (slice(r * h // rows, (r + 1) * h // rows), slice(c * w // 3, (c + 1) * w // 3))
        cell_fg = fg[cell]
        if not cell_fg.any():
            raise SystemExit(f"{sheet.name}: grid cell {i + 1} ({names[i]}) is empty")
        labels[cell][cell_fg] = i + 1
        ys, xs = np.nonzero(cell_fg)
        regions.append(((slice(cell[0].start + ys.min(), cell[0].start + ys.max() + 1),
                         slice(cell[1].start + xs.min(), cell[1].start + xs.max() + 1)), i + 1))

    alpha_full = ndimage.gaussian_filter(fg.astype(float), 0.8)
    rgb = despill_edges(rgb, fg)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for (sl, idx), name in zip(regions, names):
        mask = (labels[sl] == idx)
        alpha = np.where(mask, alpha_full[sl], 0.0)
        alpha = (np.clip(alpha * 1.15, 0, 1) * 255).astype(np.uint8)
        rgba = np.dstack([rgb[sl], alpha])
        sprite = Image.fromarray(rgba, "RGBA")
        scale = SPRITE_SIZE / max(sprite.size)
        if scale < 1:
            sprite = sprite.resize((round(sprite.width * scale), round(sprite.height * scale)), Image.LANCZOS)
        canvas = Image.new("RGBA", (sprite.width + 2 * PAD, sprite.height + 2 * PAD), (0, 0, 0, 0))
        canvas.paste(sprite, (PAD, PAD), sprite)
        path = out_dir / f"{name}.png"
        canvas.save(path, optimize=True)
        written.append(path)
    return written


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    for p in slice_sheet(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]):
        print(p)
