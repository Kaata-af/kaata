# Kaata color language

Matee revised the product direction on October 13, 2026: the app, native icon,
splash, website and dashboard use the original black identity with white and
neutral gray surfaces. The Aubergine/Saffron/Ivory palette is primarily for
flyers, social posts and other marketing material.

## Product use

Mobile controls, onboarding, selected tabs, backgrounds, text, PDF headers and
selection cues use neutral product tokens. Primary actions are black with white
text; detailed ledger rows remain white. Native adaptive-icon backgrounds,
splash light/dark backgrounds and notification accents are black. The existing
neutral Android theme plugin also keeps platform pickers, cursors and selection
handles black. Native icon/splash changes require a new binary.

The web uses the neutral shadcn new-york theme with CSS-variable tokens and the
actual Button, Card, Input and Skeleton primitives. Public actions, inputs and
shared admin chrome use those components. Existing charts, routes and data
behavior remain intact; this intentionally light website does not separately
switch Tremor chrome to dark through the operating-system preference.

Product tokens are independent of `apps/_shared/brand-palette.json`. Compatibility
names such as mobile `brandPrimary` and web `brand.primary` now resolve to neutral
product colors, not the marketing purple.

Meaningful colors remain: emerald for collect/received, garnet for pay/gave,
amber for pending, green/red/gray for explicit review/sending states, destructive
red, shared-account and member attribution cues, chart series and provider
artwork. Colors communicate these states rather than coloring routine controls.
English/Dari, large text and real-device visual checks remain release checks.

## Marketing use

The approved base palette is unchanged in `apps/_shared/brand-palette.json`:

| Color     | Value     | Marketing role                                      |
| --------- | --------- | --------------------------------------------------- |
| Aubergine | `#4A2A50` | Identity accents, actions and occasional headlines  |
| Saffron   | `#ECB84A` | Attention areas and larger flyer/social backgrounds |
| Ivory     | `#F9F2E7` | Warm marketing reading areas                        |
| Charcoal  | `#29222B` | Copy and numbers                                    |
| White     | `#FFFFFF` | Detailed reading and quiet space                    |

Keep dark ink on Saffron/Ivory; do not use pale Saffron for small text on white.
QR codes remain dark on white with their quiet zone intact. Flyers and social
sources use `marketing/assets/logo.png`, retaining the colored identity independently
of app and site logos. Existing posts, printed flyers and previously issued
statements do not change.

## Store screenshot campaign

On October 16, 2026, Matee requested a separate Persian store campaign based on
his white/blue Facebook artwork. `docs/store-assets/store-design.js` owns its
white background, black K, blue (`#1683C5`) headlines, and thin yellow
(`#FBBB19`), blue, red (`#F23C3D`) footer. It does not use Google’s logo or imply
a Google affiliation. App interfaces inside the artwork keep product colors.
All screenshot text is Persian, with English digits for amounts and counts.
The campaign leaves app, website and existing social/flyer colors unchanged.
On October 16, the images were accepted for publishing on Google Play and saved
on the App Store 2.2.0 draft. See [store-listing.md](store-listing.md) for the
verified upload status, source files and export commands.

## Artwork and generation

There is no editable logo master. The original white K on black rasters are
restored byte-for-byte from Git for mobile icon/logo/favicon/splash and the site
logo/favicon/download thumbnail. The site touch icon uses the untouched original
opaque native icon. The Play 512px source is a deterministic opaque RGB export
from the original 1024px black app icon; it is a derived export, not a byte-identical
historical 512px file. Do not redraw the K or replace it with the notification mask.

`marketing/recolor_logo.py` now writes only `marketing/assets/logo.png` and rejects
output paths outside that marketing asset directory. It keeps the original K
geometry and anti-aliasing through the established per-pixel recolor. Run its
`--check` mode to verify the marketing result. Flyer and social generators read
this independent asset. Re-running marketing generation cannot recolor app, web
or store assets.

Native black icons/splash are included in the 2.2.0 testing binaries, iOS 37 and
Android 57. This work does not edit production store listings, screenshots or
social-profile pictures.
Website changes deploy through the existing main-branch workflow. Check marketing
print/export output separately before publishing it.
