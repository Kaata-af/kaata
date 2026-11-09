# Kaata 2.3.2 store screenshots

These are **source-faithful promotional HTML compositions with fictional demonstration data**. No customer records, phone numbers, live invitations, accounts or backend calls are used. The app source reference is Android 93 / iOS 59 candidate `239cbe9111e8eca9a6891c50f094519661989812`.

The six panels show the current Home balance carousel and Friends shortcut, a customer ledger with the paper tally note, a valid calculator expression, inline Home search with filters, optional app lock, and the personal reminder editor. Ahmad Wali has AFN 12,500 and USD 100. The AFN Home totals are 25,850 to collect and 3,000 to pay. The line below the balance represents two carousel positions.

The campaign uses the white/blue layout, yellow/blue/red footer and original black icon. Thin satin device rims, physical side buttons and platform-specific camera details frame the phone screens. The app text, icons and fonts follow the product's Vazirmatn, JetBrains Mono and Ionicons styles. Green collection and cherry pay controls, the `#F8DCE2` decorative glow, physical received-left/gave-right positions, centered customer navigation, RTL note-edit placement and platform-specific passcode control follow the current components. The lock background shows one static animation frame.

The medium iPhone uses a Dynamic Island. The large Face ID iPhone uses a notch.

## Source references

- `apps/mobile/components/HomeBalanceSummary.tsx`, `BalanceCardGlass.tsx`, and `PersonRow.tsx`
- `apps/mobile/app/person/[id].tsx`, `CustomerNoteCard.tsx`, and `TallyFlowSummary.tsx`
- `apps/mobile/app/entry/new.tsx`, `EntryCalculator.tsx`, and `lib/calculator.ts`
- `apps/mobile/components/AppLockGate.tsx`, `AppLockBackground.tsx`, and `ReminderEditor.tsx`
- `apps/mobile/lib/colors.ts`, `fonts.ts`, and the Dari catalog in `i18n.ts`

## Export

Run from the repository root:

```
node docs/store-assets/render-store-assets.js
node docs/store-assets/build-upload-manifest.js
```

The installed bundled Playwright and Chrome render local files only. The exporter checks fonts, images, unexpected Latin text and visible text overflow/clipping, then guarantees opaque 8-bit RGB PNG output. The manifest builder verifies all 36 exports, exact dimensions, absence of transparency chunks, image hashes and renderer proof. Review galleries, contact sheets and detailed diagnostics are under ignored `.generated/`.

| Destination         | Size        | Folder / Apple display type         |
| ------------------- | ----------- | ----------------------------------- |
| Play phone          | 1080 x 1920 | `screenshots`                       |
| Play 7-inch tablet  | 1260 x 2240 | `tablet-screenshots/7-inch`         |
| Play 10-inch tablet | 1620 x 2880 | `tablet-screenshots/10-inch`        |
| iPhone medium       | 1206 x 2622 | `iphone-6.1` / `APP_IPHONE_61`      |
| iPhone legacy large | 1284 x 2778 | `iphone-6.5` / `APP_IPHONE_65`      |
| iPad                | 2048 x 2732 | `ipad-13` / `APP_IPAD_PRO_3GEN_129` |

`play-screenshots-manifest.json` and `apple-screenshots-manifest.json` contain the ordered upload sets, while `store-upload-manifest.json` retains the complete hash/dimension/provenance record. The primary listing locale remains `en-US`, matching the existing store; the artwork itself is Dari for the main audience. Other localized listing metadata is not changed by this export. Existing feature graphic and store icon are deliberately preserved. Old onboarding artwork is archived only under ignored `.generated/legacy-pre-2.3/` and removed from active upload folders. Only the six ordered assets from the manifests belong in this release.
