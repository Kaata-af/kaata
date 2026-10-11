#!/usr/bin/env python3
"""Build a local, self-contained social template. Nothing is published.

Edit post.template.html's copy before exporting. Supported canvas sizes are
square (1080x1080), portrait (1080x1350) and story (1080x1920).
"""
import argparse
import base64
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
SIZES = {"square": (1080, 1080), "portrait": (1080, 1350), "story": (1080, 1920)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=SIZES, default="portrait")
    args = parser.parse_args()
    palette = json.loads((REPO / "apps/_shared/brand-palette.json").read_text(encoding="utf-8"))
    fonts = REPO / "apps/web/public/fonts"
    encoded = lambda path: base64.b64encode(path.read_bytes()).decode("ascii")
    width, height = SIZES[args.format]
    replacements = {
        **{f"{{{{BRAND_{key.upper()}}}}}": value for key, value in palette.items()},
        "{{WIDTH}}": str(width),
        "{{HEIGHT}}": str(height),
        "{{FORMAT}}": args.format,
        "{{LOGO}}": encoded(REPO / "apps/web/public/logo.png"),
        "{{VAZIR_AR_400}}": encoded(fonts / "vazirmatn-arabic-400-normal.woff2"),
        "{{VAZIR_AR_700}}": encoded(fonts / "vazirmatn-arabic-700-normal.woff2"),
        "{{VAZIR_LA_400}}": encoded(fonts / "vazirmatn-latin-400-normal.woff2"),
        "{{VAZIR_LA_700}}": encoded(fonts / "vazirmatn-latin-700-normal.woff2"),
    }
    source = (HERE / "post.template.html").read_text(encoding="utf-8")
    for key, value in replacements.items():
        source = source.replace(key, value)
    if "{{" in source:
        raise ValueError("Unresolved template placeholder")
    target = HERE / f"post-{args.format}.html"
    target.write_text(source, encoding="utf-8")
    print(f"Local {args.format} artwork: {target} ({width}x{height})")


if __name__ == "__main__":
    main()
