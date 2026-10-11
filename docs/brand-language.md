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
brand colors appearing sparingly. The add/find home button is black again.
Primary buttons, selected tabs, confirmation actions and routine selection
markers use `colors.actionPrimary` (black) with white text where filled. App
surfaces, text and separators use neutral grays; detailed ledger rows stay white.

`colors.brandPrimary` remains Aubergine. Keep it for identity, the first-run
journey, occasional attention cues and exported material. Ivory stays available
for onboarding and an occasional warm highlight; Saffron stays a small accent.
Use dark ink on Saffron or Ivory and avoid giving low-contrast Saffron the job of
small text on white. This mobile refinement does not change the canonical brand
palette or the web, social and flyer source treatments.

The money-direction colors remain emerald for collect/received and garnet for
pay/gave. They carry a financial meaning. Pending retains its darker amber dot
for visibility on white; accepted has no dot and rejected retains a strike.
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

The original launcher/splash, web favicon and social-preview images have baked
backgrounds and no editable logo master in this repository. The web and
marketing sources use an exact-art CSS treatment where supported. Android's
transparent adaptive foreground can sit on Aubergine without changing its
shape; notification accent uses Aubergine. The opaque native launcher/splash
and remaining standalone raster artwork retain their original treatment until
an editable master or a faithful recolored asset is available. Keep the native
splash background matched to its opaque artwork in the meantime.

Do not replace the logo with the simplified notification mask or an approximate
redrawing. Updated source templates still need visual/print/export checks;
existing published posts, issued documents and store screenshots are unchanged.
