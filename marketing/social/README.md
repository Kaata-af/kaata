# Kaata social templates

Reusable local artwork source using the approved
[color language](../../docs/brand-language.md). Nothing is posted or published.

Edit the copy in `post.template.html`, then build a portable preview:

```sh
python build_post.py --format square
python build_post.py --format portrait
python build_post.py --format story
```

Canvas sizes are 1080×1080, 1080×1350 and 1080×1920 respectively. Output is
`post-<format>.html`, embedding the repository's Vazirmatn fonts and logo. The
generator reads `apps/_shared/brand-palette.json` so later color changes do not
require editing each template. Generated previews/exports stay out of Git.

Use Saffron for the larger attention area, Ivory for warm reading areas,
Aubergine for identity/actions and Charcoal for copy. The logo is the original
artwork recolored per pixel to Aubergine (`marketing/recolor_logo.py`), so its
exact shape is preserved.

Stories keep the logo, copy and CTA out of the top 250px and bottom 340px of the
1080×1920 canvas, where Instagram, Facebook and WhatsApp Status draw their own
UI; only the Saffron background runs into those bands.

Visual review and image export are deferred to the consolidated check after
feature additions. Inspect all three sizes, Dari shaping/line breaks, English
copy, safe areas and logo rendering before using any exported artwork.
