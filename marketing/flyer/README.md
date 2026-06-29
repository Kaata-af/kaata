# Kaata door-to-door flyer (A4, double-sided)

A printable Dari flyer for handing out shop-to-shop. Two-panel "before/after"
on the front — a photo of the worn paper khata ledgers vs. the **kaata.** app —
and a big tracked QR code on the back.

| file | tracked in git? | what it is |
|---|---|---|
| `flyer.template.html` | ✅ | editable layout + Dari copy (placeholders for fonts/photos/QR) |
| `build_flyer.py` | ✅ | generates the flyer from the template |
| `README.md` | ✅ | this file |
| `assets/panel-*.jpg` | ❌ gitignored | source photos: ledger + app screenshots (see below) |
| `flyer.pdf` / `flyer.html` | ❌ gitignored | generated print files |
| `preview-1.png` / `preview-2.png` | ❌ gitignored | generated page previews |

**Images are deliberately kept out of git** (see `.gitignore`) so the repo
doesn't bloat with binaries. The flyer is regenerated from source on demand.

## Build
```bash
cd marketing/flyer
python3 build_flyer.py        # needs: segno (pip), google-chrome, poppler-utils (for previews)
```
This produces `flyer.pdf` (print this), `flyer.html` (open in any browser →
Ctrl/Cmd+P), and `preview-1/2.png`. All are gitignored.

### Source photos (`assets/`, gitignored)
The build embeds the photos. A fresh clone must drop them in first, or the build
exits with a clear message:
- `assets/panel-notebook.jpg` — the "before", shown **full-width**, so use a
  **landscape** crop of the worn paper ledgers.
- `assets/panel-app-1.jpg`, `panel-app-2.jpg`, … — the "after": a row of
  **portrait** app screenshots shown side by side. Add/remove files to change
  the row; `build_flyer.py` picks up every `panel-app-*.jpg` in sorted order.

To re-shoot/swap, drop new files at those paths and rebuild. Tips:
- App screenshots: crop the status bar off the top; cards display portrait at a
  uniform height. **Redact phone numbers / personal data yourself** before use —
  the build does not (e.g. `-fill white -draw "rectangle x1,y1 x2,y2"`).
- Keep images ~700–1800 px on the long edge (good print, small embed).
- A phone HEIC converts with `convert IMG.HEIC -auto-orient out.jpg`.

## Two things to do before a big print run
1. **Add your WhatsApp number.** The back has a placeholder `+93 __________`.
   Edit it in `flyer.template.html` (search for `+93`) and rebuild, or just
   handwrite/stamp it. Remove the contact box entirely if you don't want one.
2. **Re-roll the QR per neighborhood/batch** so you can measure which areas
   convert. Edit `SLUG` at the top of `build_flyer.py` (e.g. `d2d_kabul_mandawi_01`)
   and rebuild. The slug is the `?s=` source param Kaata logs on download → it
   shows up per-batch in `/admin` (web_visits.source / installs.source).

## Print settings
- **A4**, **double-sided** (flip on the **short edge**), 100% scale / "actual
  size" (not "fit to page"), color. Margins (~13 mm) are built in, so it prints
  safely on any home/office printer — no full-bleed setup needed.

## How the QR works
The QR encodes `https://www.kaata.af/download?s=<slug>` — it opens the web
download page (where the visitor taps "Download APK"). The page reads the `?s=`
source param, stickies it, and reports it to the backend, so scans → installs
are still attributable per batch in `/admin` (IP + 60-min window). Because this
goes through the page, attribution depends on the visitor's browser running JS —
slightly less robust than a direct link, but it shows install instructions
first. ECC level **H** is used so the code still scans if smudged/creased.

## Honesty guardrails baked into the copy
- Only the **Android** APK is live → the flyer says "فقط برای اندروید".
- It does **not** advertise parked/coming-soon features (iPhone, Play Store,
  customer self-view, cloud backup, multi-shop, sync). Keep it that way.
