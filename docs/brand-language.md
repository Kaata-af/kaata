# Kaata color language

Approved by Matee on October 11, 2026 for the next release and future marketing.
The five base colors live in `apps/_shared/brand-palette.json`. Mobile and web
import this file; flyer/social generators read it. Go-rendered pages and emails
mirror its values explicitly, so update those styles when changing the palette.

| Color     | Value     | Role                                                                              |
| --------- | --------- | --------------------------------------------------------------------------------- |
| Aubergine | `#4A2A50` | Signature: logo, onboarding, occasional app accents, marketing actions/headlines. |
| Saffron   | `#ECB84A` | Small app highlights; larger social-post and flyer backgrounds.                   |
| Ivory     | `#F9F2E7` | Warm marketing, onboarding and selected app surfaces.                             |
| Charcoal  | `#29222B` | Brand copy and numbers; everyday mobile text uses neutral black/gray.             |
| White     | `#FFFFFF` | Ledger rows and detailed reading surfaces.                                        |

## Product use

Matee refined the mobile direction on October 11 after trying the first palette
pass: the everyday app should mainly use black, white and neutral grays, with
brand colors appearing sparingly. The home add button ("+") is black.
Primary buttons, selected tabs, confirmation actions and routine selection
markers use `colors.actionPrimary` (black) with white text where filled. App
surfaces, text and separators use neutral grays; detailed ledger rows stay white.
Android widgets the app does not draw itself (date and time dialogs, text
cursors, selection handles) follow the native theme, which
`plugins/withNeutralAndroidAccent.js` sets to black; it takes a native build.

`colors.brandPrimary` remains Aubergine. Keep it for identity, the first-run
journey, occasional attention cues and exported material. Ivory stays available
for onboarding and an occasional warm highlight; Saffron stays a small accent.
Use dark ink on Saffron or Ivory and avoid giving low-contrast Saffron the job of
small text on white. This mobile refinement does not change the canonical brand
palette or the web, social and flyer source treatments.

The money-direction colors remain emerald for collect/received and garnet for
pay/gave. They carry a financial meaning. On a closed tally row only pending
carries a dot (darker amber, for visibility on white); accepted has none and a
rejected amount keeps its strike. An opened row states the review status beside
a dot: amber pending, green accepted, red rejected, grey sending (see the
"A · Quiet" rule in CLAUDE.md and `selftest:tally-ui`).
Destructive actions and member-attribution tints retain their separate meanings.
Apple provider branding, camera surfaces and notification masks keep their
platform-specific requirements.

Measured contrast for the base pairings: white/Aubergine 12.08:1,
Charcoal/white 15.46:1, Charcoal/Ivory 13.91:1 and Charcoal/Saffron 8.48:1.
These ratios cover the base colors, not every possible overlay or disabled
state. English/Dari, larger text and real-device visual checks remain part of
the consolidated review before release.

## Marketing use

Use Ivory for warm reading areas, Saffron for larger attention areas, Aubergine
for identity/actions and Charcoal for copy. Give the logo space and retain its
existing proportions. Flyers and reusable social templates follow these roles;
they do not publish anything automatically. Keep QR codes dark on white with
their quiet zone intact. Printed statements retain full ledger contents,
white reading rows, readable direction colors and their existing print rules.

## Artwork status

There is still no editable logo master. The logo rasters were exported as a
white K on a black tile, and they are now recolored per pixel by
`marketing/recolor_logo.py`: each pixel's gray level `t` (0 = black tile,
1 = white K) becomes `lerp(Aubergine, White, t)` with alpha unchanged, so the
K's shape and anti-aliasing are exactly the original export. The script reads
the black originals from git (commit `0f7cc3b`), so re-running is safe; after a
palette change, run `python marketing/recolor_logo.py` (`--check` verifies
without writing). It produces:

- `apps/mobile/assets/icon.png` (iOS and legacy launcher icon) and
  `splash-icon.png` (native splash). `app.json` sets the splash background to
  `#4A2A50` in light and dark so it matches the opaque artwork; change both
  together.
- `apps/mobile/assets/favicon.png` and `logo.png`.
- `apps/web/public/favicon.png`, `logo.png` (site logo, `og:image`, flyer and
  social templates, which now show it as is) and a 180px `apple-touch-icon.png`.
- `docs/store-assets/play-icon-512.png` for the Play listing icon.

Android's transparent adaptive foreground sits on an Aubergine background; the
notification mask keeps its own white-on-transparent form with an Aubergine
accent. The store screenshots, Play feature graphic and the website's download
thumbnail are generated from `docs/store-assets` in the current app look and
these roles (see [store-listing.md](store-listing.md)).

Nothing outside the repository changes by itself. The App Store icon and the
native splash reach phones only with the next native build. Upload by hand: the
Play icon, feature graphic and screenshots, the App Store screenshots, and the
social-profile pictures (Facebook, Instagram, TikTok, YouTube). Link previews
refresh on each platform's own schedule (Facebook's Sharing Debugger forces a
re-scrape). Existing posts, printed flyers and issued documents stay as they
are.

Do not replace the logo with the simplified notification mask or an approximate
redrawing. Templates still need visual/print/export checks before each use.
