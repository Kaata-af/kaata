# Kaata color language

Approved by Matee on October 11, 2026 for the next release and future marketing.
The five base colors live in `apps/_shared/brand-palette.json`. Mobile and web
import this file; flyer/social generators read it. Go-rendered pages and emails
mirror its values explicitly, so update those styles when changing the palette.

| Color     | Value     | Role                                                                              |
| --------- | --------- | --------------------------------------------------------------------------------- |
| Aubergine | `#4A2A50` | Signature: primary buttons, selected tabs, logo treatments, occasional headlines. |
| Saffron   | `#ECB84A` | Small app highlights; larger social-post and flyer backgrounds.                   |
| Ivory     | `#F9F2E7` | Warm marketing, onboarding and selected app surfaces.                             |
| Charcoal  | `#29222B` | Everyday text and numbers.                                                        |
| White     | `#FFFFFF` | Ledger rows and detailed reading surfaces.                                        |

## Product use

Use Aubergine with white text for primary actions and selections. Use Charcoal
on Saffron or Ivory. Keep detailed ledger rows white and avoid decorating
individual amounts with brand colors. Secondary text and borders use restrained
plum/warm neutrals derived from this palette; do not give low-contrast Saffron
the job of small text on white.

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
