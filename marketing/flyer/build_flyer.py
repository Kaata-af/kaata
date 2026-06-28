#!/usr/bin/env python3
"""Build the Kaata door-to-door A4 flyer (front + back) into a self-contained
flyer.html, then render flyer.pdf + a preview PNG via headless Chrome.

Everything is embedded (fonts, logo, QR) so the HTML/PDF is portable to any
printer or print shop with no external files.

Change the campaign slug per neighbourhood / print batch: just edit SLUG below
and re-run. The slug is the ?s= source param that Kaata's backend logs, so each
batch's scans -> installs show up separately in /admin.
"""
import base64, pathlib, subprocess, sys

# ---- per-batch knob -------------------------------------------------------
SLUG = "d2d_kabul_01"                       # door-to-door, Kabul, batch 01
URL  = f"https://api.kaata.af/v1/download?s={SLUG}"
# ---------------------------------------------------------------------------

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
FONTS = REPO / "apps/web/public/fonts"
LOGO  = REPO / "apps/web/public/logo.png"
ASSETS = HERE / "assets"           # panel photos — gitignored, see README
CHROME = "google-chrome"

def b64(p: pathlib.Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()

def jpg_uri(p: pathlib.Path) -> str:
    return "data:image/jpeg;base64," + b64(p)

# The two panel photos live in assets/ which is deliberately kept out of git
# (binary bloat). A fresh clone must drop them in before building.
for need in ("panel-notebook.jpg", "panel-app.jpg"):
    if not (ASSETS / need).exists():
        sys.exit(f"missing source photo: assets/{need}\n"
                 f"assets/ is gitignored — see marketing/flyer/README.md for the two photos to add.")

# --- QR (segno, high error-correction for print durability) ----------------
import segno
qr = segno.make(URL, error="h")
qr_uri = qr.svg_data_uri(scale=16, border=4, dark="#000000", light="#ffffff")
print(f"QR: {URL}  (version {qr.version}, ECC=H)")

# --- assemble --------------------------------------------------------------
tpl = (HERE / "flyer.template.html").read_text(encoding="utf-8")
subs = {
    "{{VAZIR_AR_400}}": b64(FONTS / "vazirmatn-arabic-400-normal.woff2"),
    "{{VAZIR_AR_500}}": b64(FONTS / "vazirmatn-arabic-500-normal.woff2"),
    "{{VAZIR_AR_700}}": b64(FONTS / "vazirmatn-arabic-700-normal.woff2"),
    "{{VAZIR_LA_400}}": b64(FONTS / "vazirmatn-latin-400-normal.woff2"),
    "{{VAZIR_LA_700}}": b64(FONTS / "vazirmatn-latin-700-normal.woff2"),
    "{{LOGO}}": b64(LOGO),
    "{{IMG_NOTEBOOK}}": jpg_uri(ASSETS / "panel-notebook.jpg"),
    "{{IMG_APP}}": jpg_uri(ASSETS / "panel-app.jpg"),
    "{{QR_URI}}": qr_uri,
    "{{URL}}": URL,
    "{{SLUG}}": SLUG,
}
html = tpl
for k, v in subs.items():
    html = html.replace(k, v)

out_html = HERE / "flyer.html"
out_html.write_text(html, encoding="utf-8")
print(f"HTML: {out_html}  ({out_html.stat().st_size//1024} KB)")

# --- render PDF + PNG preview ---------------------------------------------
def chrome(*args):
    subprocess.run([CHROME, "--headless", "--no-sandbox", "--disable-gpu",
                    "--no-pdf-header-footer", *args],
                   check=True, capture_output=True)

if "--no-render" not in sys.argv:
    chrome(f"--print-to-pdf={HERE/'flyer.pdf'}", out_html.as_uri())
    print(f"PDF : {HERE/'flyer.pdf'}")
    # PNG previews of each page (A4 @ 150dpi) via poppler, if available
    try:
        subprocess.run(["pdftoppm", "-png", "-r", "150",
                        str(HERE / "flyer.pdf"), str(HERE / "preview")], check=True)
        print(f"PNG : {HERE/'preview-1.png'} (front), {HERE/'preview-2.png'} (back)")
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("PNG : skipped (install poppler-utils for previews)")
