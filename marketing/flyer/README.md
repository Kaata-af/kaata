# Kaata door-to-door flyer (A4, double-sided)

A printable Dari flyer for handing out shop-to-shop. Drake-style two-panel meme
(reject the paper khata notebook → choose **kaata.**) on the front, big tracked
QR code on the back.

| file | what it is |
|---|---|
| `flyer.pdf` | **print this** — A4, 2 pages (front + back), fonts/logo/QR all embedded |
| `flyer.html` | the generated, fully self-contained source (open in any browser → Ctrl/Cmd+P) |
| `preview-1.png` / `preview-2.png` | quick previews of front / back |
| `flyer.template.html` | editable layout + Dari copy + the SVG illustration |
| `build_flyer.py` | regenerates `flyer.html` + `flyer.pdf` from the template |

## Print settings
- **A4**, **double-sided** (flip on the **short edge**), 100% scale / "actual size"
  (do **not** "fit to page"), color. Plain or light cover stock is fine; the flyer
  is mostly white to keep ink cheap in volume.
- Margins are built in (~13 mm), so it prints safely on any home/office printer —
  no full-bleed setup needed. For a print shop, it also works as-is; ask for 3 mm
  bleed only if you want the panel colors to reach the paper edge.

## Two things to do before a big print run
1. **Add your WhatsApp number.** The back has a placeholder `+93 __________`.
   Edit it in `flyer.template.html` (search for `+93`) and re-run the build, or
   just handwrite/stamp it. Remove the contact box entirely if you don't want one.
2. **Re-roll the QR per neighborhood/batch** so you can measure which areas convert.
   Edit `SLUG` at the top of `build_flyer.py` (e.g. `d2d_kabul_mandawi_01`) and
   re-run. The slug is the `?s=` source param Kaata logs on download → it shows up
   per-batch in the `/admin` dashboard (web_visits.source / installs.source).

## Regenerate
```bash
cd marketing/flyer
python3 build_flyer.py            # needs: segno (pip), google-chrome, poppler-utils (optional, for previews)
```

## How the QR works
The QR encodes `https://api.kaata.af/v1/download?s=<slug>`. One scan → the backend
logs a `download` web_visit with the source, then 302-redirects straight to the
current APK on GitHub Releases (verified live: `kaata-0.8.2.apk`). Attribution to a
concrete install is by IP + a 60-minute window (see `apps/backend/internal/checkin/service.go`);
it's "good enough for store-by-store", not exact — shared Wi-Fi / carrier NAT can
mis-count. ECC level **H** is used so the code still scans if it's smudged or creased.

## Notes / honesty guardrails baked into the copy
- Only the **Android** APK is live → the flyer says "فعلاً برای تلفون‌های اندروید".
- It does **not** advertise parked/coming-soon features (iPhone, Play Store,
  customer self-view, cloud backup, multi-shop, sync). Keep it that way.
- Art is an **original illustration** in the Drake two-panel format — deliberately
  not the real Drake photo, which carries copyright + likeness risk on a printed ad.
