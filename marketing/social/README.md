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
Aubergine for identity/actions and Charcoal for copy. The existing logo's exact
shape is preserved through the same CSS treatment as the website.

Visual review and image export are deferred to the consolidated check after
feature additions. Inspect all three sizes, Dari shaping/line breaks, English
copy, safe areas and logo rendering before using any exported artwork.
