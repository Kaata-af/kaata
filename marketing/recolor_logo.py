#!/usr/bin/env python3
"""Build Kaata's Aubergine logo for flyers and social artwork only.

The original logo is a white K on a black tile. Each pixel is remapped by its
own gray level, so the K's shape and anti-aliasing stay exactly as exported:

    t     = luminance / 255              (0 = black tile, 1 = white K)
    color = lerp(Aubergine, White, t)    (colors from apps/_shared/brand-palette.json)
    alpha = unchanged

Sources are always the black originals read from git (SOURCE_COMMIT), never the
working tree, so a re-run is idempotent and a palette change is one edit to the
JSON followed by `python marketing/recolor_logo.py`. Output is confined to
marketing/assets: app, website, splash, notification and store assets are never
overwritten. `--check` compares without writing. Requires Pillow and git.
"""
import io
import json
import pathlib
import subprocess
import sys

from PIL import Image, ImageChops

REPO = pathlib.Path(__file__).resolve().parent.parent
# Last commit with the black originals (0f7cc3b, 2026-06-25).
SOURCE_COMMIT = "0f7cc3b3d44856468b6d471bccba6d6d361ae22c"

# Marketing-only destination -> exact black original source in Git.
TARGETS = {
    "marketing/assets/logo.png": "apps/web/public/logo.png",
}

# A source with more chroma than this is not a two-tone gray image.
MAX_CHROMA = 2


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def original(path: str) -> Image.Image:
    data = subprocess.run(
        ["git", "show", f"{SOURCE_COMMIT}:{path}"], cwd=REPO, check=True, capture_output=True
    ).stdout
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def recolor(image: Image.Image, dark: tuple, light: tuple) -> Image.Image:
    mode = image.mode
    if mode not in ("RGB", "RGBA"):
        raise ValueError(f"unsupported mode {mode}")
    r, g, b, a = image.convert("RGBA").split()
    for x, y in ((r, g), (g, b), (r, b)):
        if ImageChops.difference(x, y).getextrema()[1] > MAX_CHROMA:
            raise ValueError("source is not a two-tone gray image: refusing to recolor")
    # For gray pixels every luma formula returns the channel value itself.
    gray = image.convert("L")
    channels = [gray.point([(d * (255 - v) + l * v + 127) // 255 for v in range(256)])
                for d, l in zip(dark, light)]
    if mode == "RGBA":
        return Image.merge("RGBA", (*channels, a))
    return Image.merge("RGB", channels)


def encode(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def build() -> dict[str, Image.Image]:
    palette = json.loads((REPO / "apps/_shared/brand-palette.json").read_text(encoding="utf-8"))
    dark, light = hex_rgb(palette["aubergine"]), hex_rgb(palette["white"])
    images = {}
    for target, source in TARGETS.items():
        if not (REPO / target).resolve().is_relative_to((REPO / "marketing/assets").resolve()):
            raise ValueError("logo output must stay inside marketing/assets")
        images[target] = recolor(original(source), dark, light)
    return images


def same_pixels(path: pathlib.Path, image: Image.Image) -> bool:
    if not path.exists():
        return False
    current = Image.open(path)
    return (
        current.size == image.size
        and current.mode == image.mode
        and current.tobytes() == image.tobytes()
    )


def main() -> int:
    check = "--check" in sys.argv
    stale = []
    for path, image in build().items():
        target = REPO / path
        if same_pixels(target, image):
            print(f"ok      {path}")
            continue
        if check:
            stale.append(path)
            print(f"stale   {path}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(encode(image))
        print(f"wrote   {path} {image.size[0]}x{image.size[1]} {image.mode}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
