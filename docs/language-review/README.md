# Kaata language review

Pashto is implemented in this revision, including language selection,
persistence, RTL, dates, amounts, shared bills, invitations, emails and
notifications. The brand now says **personal / شخصی / شخصي**. Ninja mode,
its original icon and the phone-loss/no-account-backup warning are restored in
English, Dari and Pashto. The CTAs include **Continue in ninja mode** and
**ادامه در حالت نینجا**.

Pushing `main` triggers backend/web deployment through Dokploy; the deployment
outcome, including production migration **065**, is not verified here. Android
**2.2.2 / code 65** is built, signed and installed in place on Xiaomi; its first
cold launch succeeded. The
[device-build record](../kaata-2-testing.md) separates artifact checks from phone
testing. A new iOS build is still needed.

On 19 October 2026, the user authorized implementing the drafts and replacing
the quiet brand wording with personal. This is authorization to implement,
not a claim that each phrase received individual native-speaker proofreading.
The review files remain the place to send later wording corrections.

There are now **1,832 review entries in 19 files**: the original **1,828** rows
plus four implementation additions. The current dictionaries contain **1,493
mobile keys and 112 website keys**, each complete in English (`en`), Dari
(`fa`) and Pashto (`ps`). Supplemental rows cover copy outside those dictionaries.

## Current text and historical text

- [implementation.json](implementation.json) records authorization, approved and
  effective text by ID, current source selectors/locations, text fingerprints,
  deliberate exceptions, validation evidence and remaining work. Use `effective`
  to see what the app currently displays.
- [review-baseline.json](review-baseline.json) preserves the original review
  rows, including their original drafts and source metadata, plus the four
  dated implementation additions. Do not edit this baseline.
- [manifest.json](manifest.json), [source-snapshot.json](source-snapshot.json)
  and [drafts](drafts) describe the original extraction. Their statements that
  the app was unchanged and drafts were unapproved are historical. The source
  hashes there intentionally describe the old source revision.
- In each editable review file, `current`, `sources`, `references`, `context`
  and `placeholders` preserve the extraction snapshot. The old line numbers
  are historical; the implementation ledger supplies current source mappings.
  `proposed` records the applied decision and can receive your next correction.

Pashto decisions are marked user-authorized in `approved_locales`. Existing
English/Dari catalog text was retained except the personal brand wording,
the description of automatic backups and the later explicit Ninja-mode request.
Supplemental missing-language additions
and recovery wording clarifications are itemized by ID in the ledger; unchanged
English/Dari entries have not been blanket approved.

Two boot support-report fields deliberately remain raw English `stage:` and
`error:`. The ledger identifies them as technical labels, not translated UI.
Language selectors keep the self-names **English / دری / پښتو** in every locale.
Existing Dari singular wording and optional backup-age omissions remain intact.
The English-only `{pluralSuffix}` mechanism is omitted in Dari/Pashto backup-age
copy; the ledger records these narrow placeholder exceptions.

## Send a correction

You can review any entry independently. For example:

```text
mobile:tab.accept
ps: [preferred Pashto wording]
fa: [preferred Dari wording, if changing it]
```

Or edit that entry's `proposed` text and include the changed language in
`approved_locales`. A `null` English/Dari proposal means retaining its historical
`current` text; it does not automatically mean the latest effective text.
Use the ledger when checking a phrase that has already changed.

Keep the ID and immutable snapshot fields unchanged. Preserve named
placeholders, repetitions and line breaks. Backend `%s` placeholders also need
the correct actor/amount argument order. Review whole messages in context.

The validator allows new corrected proposals and reports how many approved
decisions await reconciliation. It does not apply or publish them. When applying
a correction, resolve the stable ID to the current source, change only the
approved language, verify its screen/message and update that entry's effective
text, approval evidence, source mapping and fingerprint in the implementation
ledger. Keep the historical baseline and unrelated decisions unchanged.

## Review files

| File                                                     | Area                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [01](review/01-onboarding.json)                          | Onboarding and introductory guide                                              |
| [02](review/02-sign-in-and-security.json)                | Sign-in, passwords, usernames and validation                                   |
| [03](review/03-account-and-preferences.json)             | Account, preferences, settings and update prompts                              |
| [04](review/04-selection-home-and-search.json)           | Selection, home, common controls and search                                    |
| [05](review/05-people-and-contacts.json)                 | People and contacts                                                            |
| [06](review/06-groups-reminders-and-credit.json)         | Groups, reminders and credit limits                                            |
| [07](review/07-entries-and-activity.json)                | Entries, conflicts and activity log                                            |
| [08](review/08-menu-and-archived-kaatas.json)            | Menu and archived kaatas                                                       |
| [09](review/09-members-and-ownership.json)               | Members, roles and ownership transfer                                          |
| [10](review/10-shared-accounts-and-notifications.json)   | Shared accounts, Accept/Reject and notifications                               |
| [11](review/11-invitations.json)                         | Invitations and joining                                                        |
| [12](review/12-device-pairing.json)                      | Device pairing and connection                                                  |
| [13](review/13-kaata-settings-and-restore.json)          | Kaata settings and restore                                                     |
| [14](review/14-messages-formatting-and-diagnostics.json) | Shared messages, formatting and diagnostics                                    |
| [15](review/15-statements-and-exports.json)              | Statements, PDF/CSV and recorded acknowledgements                              |
| [16](review/16-website.json)                             | Website and illustrative phone mockups                                         |
| [17](review/17-mobile-outside-catalog.json)              | Mobile copy outside the main dictionary                                        |
| [18](review/18-web-and-backend-outside-catalog.json)     | Web bills, invitations, emails, notifications and outreach defaults            |
| [19](review/19-implementation-additions.json)            | Pashto selector, common OK, Bluetooth development label and Ninja-mode warning |

Start with [shared accounts and notifications](review/10-shared-accounts-and-notifications.json)
for the Accept/Reject family. [priority-review.json](priority-review.json) retains
the editorial questions raised during extraction; check the implementation ledger
before treating an original implementation concern as unresolved.

## Checks

From the repository root:

```text
node scripts/language-review.mjs validate
node scripts/language-review.mjs selftest
```

Validation checks every current English/Dari/Pashto catalog key and its effective
text, unique IDs, complete review coverage, approvals, immutable historical
metadata, placeholders and implementation source mappings. Semantic selectors
track keys and resources rather than requiring entire source files to stay
unchanged. Composed Go/HTML messages use source-fragment evidence; application
tests verify interpolation and notification argument order.

The selftest rejects eight deliberate failures without changing files: duplicate
IDs, removed placeholders, edited snapshot text, unknown approval languages,
missing review rows, changed runtime catalog text, missing Pashto translations
and edited implementation fingerprints. These checks cannot certify idiom or
visual layout. Each review file also links an editor JSON schema.

The one-time `export` command refuses to overwrite review files. `inventory`
refreshes only the heuristic hardcoded-candidate queue; do not regenerate the
editable review files over existing decisions.

## Verification and remaining work

Mobile TypeScript and all **86 mobile selftest suites** passed. The native
trust-fixture CRLF/LF portability failure is fixed: line endings are normalized
while content mutations are still rejected. Checks passed for all 292 vectors
and 7 wrapper tests. Ninja-mode auth tests cover all three languages, the original icon,
CTA, warning, wrapping, RTL, order, busy state and redirects.

The website production build and 52 tests passed. Backend build, locale/mail/bill
suites, selected invitation/notification checks, and actual isolated PostgreSQL
language-persistence/outreach/migration checks passed. The test database was
removed without touching development data. Bundled Vazirmatn weights
400/500/600/700 cover all 51 Arabic-script characters in the Pashto drafts.

The arm64 Android device build passed all **37 AAB and 29 APK static checks**.
All **4,479 catalog strings**, fresh native English/Dari/Pashto resources,
the exact Ninja copy/icon and the original installed Play signer were verified.
Code 65 is an internal draft only; existing published releases and listings
were preserved. The in-place Xiaomi update succeeded without uninstalling or
resetting application data, retained its original installation timestamp and
cold-launched successfully in 1,433 ms. Native phone layout, Pashto/Ninja visual
review, line wrapping, OS permissions and actual notification delivery still
need device checks with the user. Browser visual smoke testing was unavailable
because no browser surface was enabled.

The original [language-files.json](language-files.json),
[language-surfaces.json](language-surfaces.json),
[dynamic-keys.json](dynamic-keys.json),
[repeated-wording.json](repeated-wording.json),
[current-placeholder-issues.json](current-placeholder-issues.json) and
[hardcoded-candidates.json](hardcoded-candidates.json) remain snapshot audit aids.
They include technical code and comments, duplicated copy and computed keys;
they are not a claim that every displayed word is translated.

Legal/admin prose beyond the extracted outreach defaults remains a separate
audit. Live announcements, operator template overrides, store listings/artwork,
historical release notes and Google/Apple/OS-owned screens were not changed.
User-entered names, notes and account data are not translation copy.
