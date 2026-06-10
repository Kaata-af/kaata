import { getLocales } from "expo-localization";
import { getAppMeta } from "./db";

// Tiny home-rolled i18n. Two reasons we didn't pull in i18next / react-i18next:
//   1. kaata has ~50 strings total — overkill ratio.
//   2. We're locked LTR (see app/_layout.tsx) and don't need framework-level
//      RTL plumbing yet. When that changes, swap to a real lib.
//
// Font switching is handled separately in lib/fonts.ts — when the device
// locale is fa/prs, every `fonts.sansBold` etc. reference resolves to
// Vazirmatn automatically. This module's only job is string lookup.
//
// In-app override:
//   Users can pick a language explicitly in Settings. That preference is
//   persisted in app_meta under "locale_pref" (values: 'system' | 'en' | 'fa').
//   On app start, `initLocaleFromPref()` is awaited before the first render
//   so the very first frame uses the chosen locale. `setLocale()` updates
//   the active locale at runtime for subsequent re-renders.
//
//   Font caveat: lib/fonts.ts evaluates the script choice ONCE at module
//   load based on device locale — it can't read app_meta synchronously. So
//   for users who override their device locale via this toggle, Persian
//   glyphs fall back to the system Arabic font until the next app launch.
//   This is rarely visible in practice (most Afghan users already have a
//   Persian device locale) but worth knowing.

// Source-of-truth English strings. All other locales must use the same keys.
const en = {
  // Onboarding
  "onboarding.subtitle": "A quiet ledger between you and the people you trust.",
  "onboarding.name.label": "Your name",
  "onboarding.name.placeholder": "Sultan",
  "onboarding.phone.label": "Phone number (optional)",
  "onboarding.phone.placeholder": "+93 7…",
  "onboarding.phone.hint":
    "Used so staff can find you in their contacts when pairing. Not verified, not shared.",
  "onboarding.shop.label": "Store or business name",
  "onboarding.shop.labelOptional": "Kaata name (optional)",
  "onboarding.shop.placeholder": "Shop Sultan",
  "onboarding.shop.hint":
    "Skip if you're joining an existing kaata. You can create or rename later.",
  "onboarding.continue": "Continue",
  "onboarding.nameRequired": "Name required",

  // Onboarding step 1 — language picker. Only shown when device locale
  // isn't already Persian/Dari.
  "onboardingLanguage.title": "Choose your language",
  "onboardingLanguage.subtitle": "You can change this later in Settings.",

  // Onboarding mode picker (step 2 — appears after name + shop)
  "onboardingMode.title": "How would you like to use kaata?",
  "onboardingMode.subtitle": "You can change this later in Settings.",
  "onboardingMode.google.title": "Sign in with Google",
  "onboardingMode.google.body":
    "Back up your kaata to the cloud. Restore it on a new phone if you lose this one.",
  "onboardingMode.offline.title": "Stay fully offline",
  "onboardingMode.offline.body":
    "No account. Your kaata never leaves this phone — private by default.",
  "onboardingMode.signInFailed": "Sign-in didn't work. Try again.",
  "onboardingMode.expoGoHint": "Sign-in works on the real app; for now you can continue offline.",
  "onboardingMode.back": "Back",

  // Onboarding profile (last step before the tour)
  "onboardingProfile.title": "Almost done",
  "onboardingProfile.signedInHint": "Signed in as {email}",
  "onboardingProfile.continue": "Continue",
  "onboardingProfile.nameRequired": "Please enter your name",
  "onboardingProfile.shopRequired": "Please name your Kaata",
  "onboardingProfile.joinExisting": "I'll join an existing kaata instead",

  // Onboarding restore (inserted between auth and profile when the
  // backend has existing ledger state for the signed-in account).
  "onboardingRestore.title": "We found your kaata",
  "onboardingRestore.subtitle": "Last saved on {date}.",
  "onboardingRestore.restore.title": "Restore from cloud",
  "onboardingRestore.restore.body": "Bring back your people, entries, and shop on this phone.",
  "onboardingRestore.fresh.title": "Start fresh",
  "onboardingRestore.fresh.body": "Ignore the cloud copy and set up a clean ledger on this phone.",
  "onboardingRestore.restoring": "Restoring your kaata…",
  "onboardingRestore.tryAgain": "Try again",
  "onboardingRestore.startFresh": "Start fresh",
  "onboardingRestore.errorTitle": "Couldn't restore",
  "onboardingRestore.errorSessionExpired": "Your sign-in expired. Sign in again to restore.",
  "onboardingRestore.errorTimeout": "Network was too slow. Try again on a better connection.",
  "onboardingRestore.errorGeneric": "Something went wrong. Try again.",

  // First-time guided tour was deprecated — keys removed. See
  // docs/tour-redesign.md for the postmortem + the recommended
  // approach for a future attempt.

  // Profile menu — only keys referenced by ProfileSettingsSheet remain.
  // The signedInAs/notSignedIn/account/accountHint keys belonged to the
  // killed /account screen (Phase 7 D-ACCOUNT-PAGE-ROLE) and were dropped.
  "profile.menu.preferences": "Preferences",
  "profile.menu.preferencesHint": "Language, currency, region",

  // Phase 4.1: "different Google account on this phone?" prompt.
  // (Other account.* keys belonged to the killed /account screen.)
  "account.differentAccount.title": "Different Google account on this phone",
  "account.differentAccount.body":
    "This phone is currently linked to {oldEmail}. You just picked {newEmail}. What do you want to do?",
  "account.differentAccount.keep": "Switch, keep my data",
  "account.differentAccount.wipe": "Switch, start fresh",
  "account.differentAccount.cancel": "Cancel",

  // Preferences screen — section-by-section copy. Phase 7 D-PREFERENCES-PAGE
  // expanded the surface to include placeholders for Appearance + Notifications
  // (both disabled pending Phase 8+ work).
  "preferences.title": "Preferences",
  "preferences.currency.section": "Currency",
  "preferences.currency.defaultHint": "Used for new Kaatas. Each Kaata can override.",
  "preferences.region.section": "Region",
  "preferences.country.label": "Default country",
  "preferences.country.hint":
    "The country picker on new contacts starts here. Doesn't change any existing phone numbers.",
  "preferences.country.changed": "Default country updated.",
  "preferences.appearance.section": "Appearance",
  "preferences.appearance.theme": "Theme",
  "preferences.appearance.themeHint": "Light, dark, or follow the system.",
  "preferences.notifications.section": "Notifications",
  "preferences.notifications.reminders": "Reminders",
  "preferences.notifications.remindersHint": "Get pinged about unpaid balances.",
  "preferences.comingSoon": "Coming soon",

  // (Phase 5 mesh "Shop Mode" copy lives under the menu.sync.shopMode.*
  // namespace — the hamburger menu is the only surface. The earlier
  // settings.shopMode.* block was a pre-redesign draft and has been removed.)

  // Home
  "home.tab.collect": "To collect",
  "home.tab.pay": "To pay",
  "home.total.label.collect": "To collect",
  "home.total.label.pay": "To pay",
  "home.empty.collect.title": "Nothing to collect yet",
  "home.empty.collect.subtitle": "Tap the + button to add someone you keep accounts with.",
  "home.empty.pay.title": "You owe no one yet",
  "home.empty.pay.subtitle":
    "When you take goods or borrow money, log it from that person's page and they'll appear here.",
  "home.from.someone": "from {count} person",
  "home.from.many": "from {count} people",
  "home.empty.noOneYet": "no one here yet",
  "home.empty.allSettled": "everyone settled",

  // Person detail
  "person.action.iGave": "I gave",
  "person.action.iReceived": "I received",
  "person.balance.theyOwe": "THEY OWE YOU",
  "person.balance.youOwe": "YOU OWE THEM",
  "person.balance.settled": "SETTLED",
  "person.empty.title": "No entries yet",
  "person.empty.subtitle":
    'Tap "I gave" when money or goods leave your hand, "I received" when they come in.',
  "person.ping": "Ping {name} on WhatsApp",
  "person.delete.title": "Delete this entry?",
  "person.delete.description":
    "The amount stops counting toward this person's balance. You can't undo this from here.",
  "person.delete.confirm": "Delete",
  "person.sheet.edit": "Edit",
  "person.sheet.delete": "Delete",
  "person.row.noEntries": "no entries yet",
  "person.row.settled": "settled",

  // Person edit / add
  "personEdit.title": "Edit person",
  "personEdit.name.label": "Name",
  "personEdit.phone.label": "WhatsApp number",
  "personEdit.save": "Save changes",
  "personAdd.title": "Add or find person",
  "personAdd.name.placeholder": "Type to search or add",
  "personAdd.pickContact": "or pick from your contacts",
  "personAdd.add": "Add {name}",
  "personAdd.phone.hint": "Needed to send pings on WhatsApp.",
  "personAdd.phone.invalid": "Couldn't read that phone number. Try +93 70 123 4567.",
  "personAdd.phone.conflict": "Phone already used by {name}",
  "personAdd.section.matches": "Matches",
  "personAdd.section.recent": "Recent",
  "personAdd.noMatch": 'No one matches "{query}".',
  "personAdd.empty.title": "No one here yet",
  "personAdd.empty.subtitle": "Type a name above to add your first person.",
  "personAdd.rightAmount.new": "new",
  "personAdd.rightAmount.settled": "settled",
  "personAdd.personNotFound": "Person not found.",

  // Entry
  "entry.amount.label": "Amount (AFN)",
  "entry.note.label": "Note",
  "entry.note.placeholder": "Flour and tea",
  "entry.save": "Save",
  "entry.saveChanges": "Save changes",
  "entry.context.to": "to",
  "entry.context.from": "from",
  "entry.edit.title": "Edit · {verb}",
  "entry.edit.hint":
    'Direction can\'t be changed. To turn this into "{otherVerb}", delete this entry and add a new one.',
  "entry.notFound": "This entry no longer exists.",
  "entry.invalidAmount": "Enter a valid amount",
  // D-DEFENSIVE-ARCHIVED-GUARD — surfaced when the active vault has been
  // archived by the user (locally) or via mesh between the screen load
  // and a create-flow tap.
  "entry.noActiveVault": "No active Kaata. Create one to continue.",
  "entry.vaultArchived": "This Kaata is archived. Restore it or pick another.",
  "home.fab.blockedArchived": "This Kaata is archived. Restore it or pick another.",
  "entry.saved": "Entry saved",
  "entry.updated": "Entry updated",
  "entry.deleted": "Entry deleted",
  "entry.saveFailed": "Couldn't save. Try again.",
  // Surfaced when a local write is refused by the projection's role-gate
  // — usually because a co-owner demoted this device to viewer/editor and
  // the demotion gossiped in via mesh/sync between screen-load and save.
  "entry.roleDenied": "View only — ask the owner for editor access.",

  // Projection-conflicts surface (Phase 8 D-PROJECTION-CONFLICTS-SURFACE).
  // Toasted by ProjectionConflictsListener at the root of the app.
  "projectionConflicts.toast.roleGate": "Your role changed — that change couldn't be saved.",
  "projectionConflicts.toast.serverRejected":
    "The server didn't accept your last change. Please refresh.",

  // Settings — "settings.saved" is still used by person/edit's auto-save
  // toast. Other settings.* keys (title/name.label/shop.*/save) belonged
  // to the killed v0 Settings screen and were dropped (Phase 7).
  "settings.saved": "Saved",
  "settings.language.label": "Language",
  "settings.language.option.system": "System default",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "Language updated.",
  "settings.currency.label": "Default currency",
  "settings.currency.hint":
    "This relabels how amounts are shown. It does not convert existing entries.",
  "settings.currency.changed": "Currency updated.",
  "home.exit.hint": "Press back again to exit.",
  "entry.amount.labelTemplate": "Amount ({code})",

  // Country picker
  "country.title": "Choose country",
  "country.search": "Search by name or code",
  "country.noMatch": "No match.",

  // Contacts picker
  "contacts.title": "Pick from contacts",
  "contacts.search": "Search by name",
  "contacts.permission.title": "Contacts access needed",
  "contacts.permission.body":
    "Open your phone settings and allow Kaata to access contacts to use this shortcut.",
  "contacts.permission.button": "Open settings",
  "contacts.empty.none": "No contacts on this phone.",
  "contacts.empty.noMatch": 'No contact matches "{query}".',
  "contacts.noPhone": "no phone",

  // WhatsApp share — full message body sent to the customer.
  "share.greeting": "Salaam {name}.",
  "share.theyOwe.header": "Your kaata at {accountWith}:",
  "share.theyOwe.amount": "🔴 You owe: −{amount} {currency}",
  "share.theyOwe.cta": "Please settle when you can.",
  "share.youOwe.header": "Our kaata:",
  "share.youOwe.amount": "🟢 I owe you: +{amount} {currency}",
  "share.youOwe.cta": "I will settle soon.",
  "share.settled.line": "🤝 Our kaata is fully settled.",
  "share.settled.cta": "Thank you.",
  "share.footer": "— Sent via Kaata.af",

  // Brand
  "brand.wordmark": "kaata.",

  // Relative time formatting (used in row subtitles & entry timestamps).
  // {n} is the number; in Persian the unit follows the number, then "پیش"
  // (= "ago") closes the phrase.
  "format.justNow": "just now",
  "format.minutesAgo": "{n}m ago",
  "format.hoursAgo": "{n}h ago",
  "format.yesterday": "yesterday",
  "format.daysAgo": "{n}d ago",
  "format.weeksAgo": "{n}w ago",

  // Common
  "common.cancel": "Cancel",
  "common.back": "Back",
  "common.retry": "Retry",
  "common.done": "Done",
  "common.loading": "Loading…",
  "common.tryAgain": "Try again",
  "common.removed": "{name} removed",
  "common.remove": "Remove",
  "common.remove.title": "Remove {name}?",
  "common.remove.description":
    "They'll disappear from your list. Their entries stay on your device.",

  // Profile sheet (Phase 7) — every label/section header in the unified
  // settings surface. Section headers are stored in normal case; the
  // SectionHeader atom applies textTransform: "uppercase" at render time.
  // Storing them upper-cased in source ("ALL KAATAS") looked correct in
  // EN but produced shouting parity issues against Persian where the
  // script has no case — the styled transform is a no-op for fa, so we
  // keep the source consistent across locales and let the render layer
  // handle visual case.
  "menu.title.profile": "Profile and settings",
  // a11y label for the top-left vault-switcher Pressable in the home
  // header. Distinct from menu.allKaatas (the section header label) so
  // a screen reader doesn't announce "ALL KAATAS" — that's chrome
  // styling, not the affordance description.
  "menu.title.vaultSwitcher": "Switch Kaata",
  // Phase 7: only menu.thisKaata.settings is referenced (the "Manage
  // this kaata" entry in ProfileSettingsSheet + VaultPickerSheet). The
  // rest of the menu.thisKaata.* keys belonged to the deleted hamburger
  // sheet; removed to keep the translation surface honest.
  "menu.thisKaata.settings": "Manage this Kaata",
  "menu.allKaatas": "All Kaatas",
  "menu.allKaatas.empty": "No Kaatas yet.",
  "menu.allKaatas.empty.withArchived": "No active Kaatas.",
  "menu.allKaatas.add": "Add a Kaata",
  "menu.allKaatas.scan": "Scan a pairing code",
  "menu.allKaatas.scan.hint": "Join an existing Kaata from another phone",
  "menu.allKaatas.switched": "Switched Kaata",
  "menu.allKaatas.switchFailed": "Could not switch Kaata",
  "menu.allKaatas.archived.show": "Show archived ({count})",
  "menu.allKaatas.archived.hide": "Hide archived ({count})",
  // D-VAULTPICKER-CLEANUP / D-ARCHIVED-SCREEN — compact footer-link
  // label rendered in both VaultPickerSheet and ProfileSettingsSheet
  // when the user has at least one archived Kaata. Routes to
  // /vault/archived.
  "menu.allKaatas.archived.view": "Archived ({count})",
  // D-ARCHIVED-SCREEN — dedicated archived list page.
  "vaultArchived.title": "Archived",
  "vaultArchived.empty": "No archived Kaatas yet.",
  // UX-fix #3: friendlier empty-state subtitle + a CTA so the user
  // isn't stranded with only the back chevron after restoring the
  // last archived row.
  "vaultArchived.emptySubtitle": "Everything is back in your active Kaatas.",
  "vaultArchived.emptyCta": "Back to Kaatas",
  "vaultArchived.restoreButton": "Restore",
  // UX-fix #2: server-anchored rows surface a distinct affordance so
  // the user doesn't tap "Restore" only to get an error toast.
  "vaultArchived.restoreFromCloud": "Restore from cloud",
  "vaultArchived.serverAnchoredHint": "Stored on the server — restore via cloud backup",
  "vaultArchived.restoredToast": "Restored {name}",
  "vaultArchived.restoreFailed": "Could not restore Kaata",
  "vaultArchived.unarchiveUnsupported": "Restore from cloud to recover this Kaata",
  "vaultArchived.archivedAt": "Archived {relative}",
  "vaultArchived.relative.justNow": "just now",
  "vaultArchived.relative.minutesAgo": "{n} min ago",
  "vaultArchived.relative.hoursAgo": "{n} hr ago",
  "vaultArchived.relative.daysAgo": "{n} d ago",
  "vaultArchived.relative.monthsAgo": "{n} mo ago",
  "members.singular": "{count} member",
  "members.plural": "{count} members",
  // Phase 7 D-TOP-LEFT-SWITCHER — vault picker triggered by tapping the
  // shop name in the home header. The "manage" row replaces the former
  // hamburger "This Kaata > Settings" entry and routes to vault/settings.
  "vaultPicker.manage": "Manage current Kaata",
  "menu.sync": "Sync",
  "menu.sync.never": "Not synced yet",
  "menu.sync.justNow": "just now",
  "menu.sync.minAgo": "{n} min ago",
  "menu.sync.hrAgo": "{n} hr ago",
  "menu.sync.dayAgo": "{n} d ago",
  "menu.sync.now": "Sync now",
  "menu.sync.restore": "Restore from cloud",
  "menu.sync.done": "Synced ({pulled} in, {pushed} out)",
  "menu.sync.failed": "Sync failed",
  "menu.sync.offline": "You appear to be offline.",
  // Compact relative-time label used as the trailing string on the SYNC
  // section header (right side, muted). Differs from menu.sync.lastSynced
  // (the inline full row); here the term must be terse — section headers
  // are 11px and the trailing label can't wrap.
  "menu.sync.header.never": "—",

  // In-app "Restore from cloud" confirm screen (NOT onboarding/restore).
  // The onboarding flow has its own copy because the user there has no
  // local data to lose. In-app the user MAY have local-only edits, so
  // the wording emphasises replacement.
  "restore.confirm.title": "Restore from cloud?",
  "restore.confirm.body":
    "This will replace everything on this phone with your cloud copy. Any changes made here that aren't already synced will be lost.",
  "restore.confirm.cta": "Replace local data",
  "restore.confirm.cancel": "Cancel",
  "restore.toast.noBackup": "No cloud backup found for this account.",
  "restore.toast.success": "Restored from cloud.",
  "restore.toast.sessionExpired": "Signed out. Sign in again to restore.",
  "restore.toast.timeout": "Restore timed out. Check your connection.",
  "restore.toast.generic": "Restore failed.",
  // Phase 6: BLE is now the PRIMARY transport. Toggle copy must match — a
  // shopkeeper reading "over WiFi" on a cellular-only phone is exactly the
  // user we built BLE for, and the old copy would make them never turn it
  // on. Keep "Nearby sync" as the noun-form key elsewhere (notification
  // channel, toasts) for stability; the visible label is the long form.
  "menu.sync.shopMode": "Sync with phones nearby",
  "menu.sync.shopMode.hint": "Works over Bluetooth — no wifi or internet needed.",
  "menu.sync.shopMode.hintWithPeers": "{count} phones nearby",
  "menu.sync.shopMode.hintOnePeer": "1 phone nearby",
  "menu.sync.shopMode.hintLooking": "Looking for nearby phones…",
  "menu.sync.shopMode.failed": "Could not toggle Nearby sync.",
  "menu.sync.shopMode.fgsFailed":
    "Couldn't start Nearby sync — please allow notifications and try again.",
  "menu.sync.shopMode.startedToast": "Nearby sync on.",
  // Phase 6 — BLE permission rationale shown BEFORE the OS dialogs. Stock
  // Android's "find/connect/relative position of nearby devices?" copy
  // panics non-technical users; this dialog frames it in shopkeeper terms.
  "menu.ble.permRationale.title": "Allow Bluetooth to find nearby phones",
  "menu.ble.permRationale.body":
    "Kaata uses Bluetooth to find your other phone and your staff's phones in the shop. No internet needed. We never share your location.",
  "menu.ble.permRationale.continue": "Continue",
  "menu.ble.permRationale.cancel": "Not now",
  "menu.ble.permDenied.title": "Bluetooth permission needed",
  "menu.ble.permDenied.body":
    "Nearby sync needs Bluetooth permission to find your other phones. Open settings to grant it?",
  "menu.ble.permDenied.openSettings": "Open settings",
  "menu.ble.permDenied.cancel": "Not now",
  "menu.ble.unsupported": "This phone can't broadcast Bluetooth — Nearby sync won't work here.",
  "menu.ble.adapterOff": "Bluetooth is off. Turn it on to sync nearby.",
  // Phase 9 D-FALLBACK-UX — runtime failure toasts surfaced via
  // setMeshFailureBridge. Capability-framing copy ("can still find Kaata
  // phones"), never uses the word "error".
  "menu.ble.peripheralUnsupported":
    "Your phone can't broadcast to others, but it can still find nearby Kaata phones. Ask the other phone to start Nearby sync.",
  "menu.ble.peerHandshakeFailed":
    "Couldn't connect to a nearby phone. They may be from a different Kaata or their session expired.",
  "menu.ble.peerDecryptFailed": "Lost connection to a nearby phone. Retrying.",
  // Battery-optimization prompt (Phase 5.1, reworded for BLE-primary).
  "menu.battery.title": "One last step: allow background",
  "menu.battery.description":
    "Nearby sync needs Android to keep Kaata's Bluetooth scan running while your phone is locked or in your pocket. Next: Settings → Battery → Unrestricted.",
  "menu.battery.confirm": "Open settings",
  "menu.battery.skip": "Skip — turn off Nearby sync",
  // Phase 6 — wifi-upgrade prompt. Surfaced when initial sync is estimated
  // to take >2min over BLE. Body is BLE-aware ("on the same wifi" is the
  // actual requirement); "Cancel sync" was dropped because it was the
  // wrong-default destructive action sandwiched between two non-destructive
  // ones — users who want to abort just toggle the master switch off.
  "wifiUpgrade.title": "Sync ~{count} entries — about {min} min over Bluetooth",
  "wifiUpgrade.body": "Connect both phones to the same wifi to finish in seconds.",
  "wifiUpgrade.tryWifi": "Try wifi",
  "wifiUpgrade.stayBle": "Stay on Bluetooth",
  // Retained for back-compat with older bridges; not surfaced in the
  // canonical Phase 6 prompt.
  "wifiUpgrade.cancel": "Stop syncing",
  "wifiUpgrade.toast.switched": "Switched to wifi for faster sync",
  "wifiUpgrade.toast.fallback": "Couldn't connect over wifi, using Bluetooth",
  "wifiUpgrade.toast.autoDismissed": "Continuing over Bluetooth",
  "wifiUpgrade.toast.searching": "Looking for the other phone on wifi…",
  "menu.account": "Account",
  "menu.account.signIn": "Sign in with Google",
  "menu.account.signIn.toast": "Signed in",
  "menu.account.signIn.failed": "Couldn't sign in — try again",
  "menu.account.signOut": "Sign out",
  "menu.account.signOut.toast": "Signed out",
  "menu.account.signOut.failed": "Couldn't sign out — try again",
  // Phase 7 UX critique #6 — sign-out is destructive (kills server sync
  // until next sign-in), so it gets a ConfirmDialog gate per the
  // documented contract in design-tokens.ts. The body interpolates the
  // current email when known so the user knows which account they're
  // exiting; falls back to a generic phrasing when only the local
  // session exists.
  "menu.account.signOut.confirm.title": "Sign out?",
  "menu.account.signOut.confirm.body":
    "You'll be signed out of {email}. Your local Kaatas stay on this phone, but cloud sync and restore won't work until you sign in again.",
  "menu.account.signOut.confirm.bodyGeneric":
    "Your local Kaatas stay on this phone, but cloud sync and restore won't work until you sign in again.",
  "menu.account.signOut.confirm.cta": "Sign out",
  "menu.account.switch": "Switch Google account",
  "menu.account.localOnlyHint": "Sign in to enable backup + sync across phones.",
  // ABOUT section
  "menu.about": "About",
  "menu.about.versionLine": "Version {version}",
  "menu.about.versionLineWithBuild": "Version {version} · build {build}",

  // Vault create (Phase 5.2 — Add a Kaata)
  "vaultNew.title": "Create a Kaata",
  // UX-fix #1: forced post-archive-last entry-point title. The back
  // chevron is hidden in this mode (no parent to pop to); the title
  // shifts to a directive framing so the screen reads as "you must
  // complete this".
  "vaultNew.titleForced": "Create a Kaata to continue",
  "vaultNew.name.label": "Kaata name",
  "vaultNew.name.placeholder": "My new shop",
  "vaultNew.name.required": "Name is required",
  "vaultNew.currency.label": "Currency",
  "vaultNew.currency.hint":
    "Default for all amounts in this Kaata. Can be changed later in settings.",
  "vaultNew.localOnlyHint":
    "You are not signed in. This Kaata will live only on this phone until you sign in.",
  "vaultNew.submit": "Create Kaata",
  "vaultNew.created": "Created {name}",
  "vaultNew.failed": "Failed to create kaata",

  // Vault pair (owner side) — Phase 5 server-anchor + Phase 7 local-CA
  "vaultPair.title": "Pair a phone to this Kaata",
  "vaultPair.headline": "Pair another phone to",
  "vaultPair.instructions.local":
    "On the OTHER phone (the one you want to add):\n" +
    "1. Open Kaata.\n" +
    "2. Tap the profile icon (top-right) → Add a Kaata → Scan a pairing code.\n" +
    "3. Point its camera at the code below.",
  "vaultPair.instructions.server":
    "On the OTHER phone (the one you want to add):\n" +
    "1. Sign in with the same Google account.\n" +
    "2. Tap the profile icon (top-right) → Add a Kaata → Scan a pairing code.\n" +
    "3. Point its camera at the code below.",
  "vaultPair.codeExpired": "Code expired",
  "vaultPair.generating": "Generating…",
  "vaultPair.expiresIn": "Expires in {time}",
  "vaultPair.generateNew": "Generate a new code",
  "vaultPair.sendLink": "Send link instead",
  "vaultPair.sendLink.opening": "Opening…",
  "vaultPair.shareLinkMessage": "Pair my other phone with Kaata: {url}",
  "vaultPair.shareLinkReady": "Link ready to share",
  "vaultPair.shareLinkFailed": "Couldn't share link",
  "vaultPair.noActiveKaata": "No active kaata",
  "vaultPair.vaultNotFound": "Kaata not found",
  "vaultPair.signInFirst": "Sign in first to pair a phone",
  "vaultPair.loadFailed": "Failed to load pairing",
  "vaultPair.fineprint.local":
    "The other phone does NOT need to be signed in — pairing is direct between the two phones over Bluetooth.",
  "vaultPair.fineprint.server":
    'The other phone must be signed in with the same Google account as this one. To invite someone else (a different Google account), use "Invite member" instead.',
  // D-PAIR-WITH-ROLE — role picker on pair.tsx
  "vaultPair.role.title": "Choose this phone's role on",
  "vaultPair.role.subtitle":
    "Pick what the other phone is allowed to do once paired. You can change this later.",
  "vaultPair.role.owner": "Owner",
  "vaultPair.role.owner.body":
    "Full control. Can add or remove members, change roles, edit and delete anything.",
  "vaultPair.role.editor": "Editor",
  "vaultPair.role.editor.body":
    "Day-to-day staff. Can add and edit entries, but cannot manage members.",
  "vaultPair.role.viewer": "Viewer",
  "vaultPair.role.viewer.body":
    "Read-only. Can see balances and entries, but cannot change anything.",
  "vaultPair.role.continue": "Show pairing code",
  "vaultPair.role.committed": "This code grants the role: {role}",

  // Vault pair (scanner side)
  "vaultPairScan.title": "Scan pairing code",
  "vaultPairScan.permission.headline": "Camera access needed",
  "vaultPairScan.permission.body":
    "Kaata needs the camera to scan the pairing code shown on the other phone. We do not record or upload any photos.",
  "vaultPairScan.permission.allow": "Allow camera",
  "vaultPairScan.scanning.hint": "Point the camera at the QR code shown on the OTHER phone",
  "vaultPairScan.confirm.prefix": "Join",
  "vaultPairScan.confirm.body.local":
    "This phone will become a second device on the kaata. Both phones will sync over Bluetooth when close to each other — no internet needed.",
  "vaultPairScan.confirm.body.server":
    "This phone will become a second device on the kaata. Your entries will sync over the internet, and also peer-to-peer when both phones are near each other.",
  "vaultPairScan.confirm.join": "Join kaata",
  "vaultPairScan.confirm.rescan": "Re-scan",
  "vaultPairScan.joining": "Joining {name}…",
  "vaultPairScan.joined.headline": "Paired with",
  "vaultPairScan.joined.body.local":
    "Both phones will sync over Bluetooth when close to each other. Nearby sync is on.",
  "vaultPairScan.joined.body.server":
    "Both phones will sync over the internet, and over Bluetooth when nearby. Nearby sync is on.",
  "vaultPairScan.toast.pairedNearby": "Paired — now syncing nearby",
  "vaultPairScan.error.headline": "Couldn't pair",
  "vaultPairScan.error.signInRequired":
    "Sign in with the same Google account as the other phone first.",
  "vaultPairScan.error.accountMismatch":
    "This code was issued for a different Google account. Ask the owner to send you an email invitation instead.",
  "vaultPairScan.error.generic": "Pairing failed",
  "vaultPairScan.error.expired":
    "This pairing code has expired. Ask the owner to generate a new one.",
  "vaultPairScan.error.unsupported":
    "This code is from a newer version of Kaata. Update the app and try again.",
  "vaultPairScan.error.malformed":
    "Couldn't read this code. Make sure you scanned a Kaata pairing code.",
  // D-PAIR-WITH-ROLE — confirmation screen role surfacing
  "vaultPairScan.confirm.asRole": "as {role}",
  "vaultPairScan.confirm.roleMissing": "Role not specified in this code — joining as Editor.",

  // Vault settings — Phase 7 UX critique #8 (translated).
  "vaultSettings.title": "Kaata settings",
  "vaultSettings.role.owner": "Owner",
  "vaultSettings.role.editor": "Editor",
  "vaultSettings.role.viewer": "Viewer",
  "vaultSettings.section.details": "Details",
  "vaultSettings.section.members": "Members",
  "vaultSettings.section.activity": "Activity",
  "vaultSettings.section.danger": "Danger zone",
  "vaultSettings.section.membership": "Membership",
  "vaultSettings.name.label": "Kaata name",
  "vaultSettings.name.required": "Name is required",
  "vaultSettings.currency.label": "Currency",
  "vaultSettings.viewOnly": "View only — owner permission required.",
  "vaultSettings.toast.noActive": "No active Kaata",
  "vaultSettings.toast.notFound": "Kaata not found",
  "vaultSettings.toast.loadFailed": "Failed to load Kaata",
  "vaultSettings.toast.saved": "Kaata renamed",
  "vaultSettings.toast.saveFailed": "Couldn't save name. Try again.",
  "vaultSettings.toast.currencyUpdated": "Currency updated",
  "vaultSettings.toast.currencyFailed": "Failed to update currency",
  "vaultSettings.toast.archived": "Kaata archived",
  "vaultSettings.toast.archiveFailed": "Failed to archive",
  "vaultSettings.archive.success": "Kaata archived",
  // UX-fix: include the OLD vault name so the user reads the toast as a
  // direct consequence ("Archived X. Switched to Y.") instead of an
  // incidental notification ("Switched to Y."). Both names are
  // interpolated.
  "vaultSettings.archive.successSwitched": "Archived {old}. Switched to {name}.",
  "vaultSettings.archive.successNeedNew": "Kaata archived. Create a new Kaata to continue.",
  // UX-fix #1 (Phase 7 finalize): when the just-archived vault was the
  // last active one BUT archived vaults exist, the user is routed to
  // /vault/archived first — restoring is a faster recovery than
  // re-creating, and the user just intentionally archived this vault.
  "vaultSettings.archive.successNeedRestore": "Kaata archived. Restore one to continue.",
  "vaultSettings.toast.left": "Left Kaata",
  "vaultSettings.toast.leaveFailed": "Failed to leave",
  "vaultSettings.row.members": "Members",
  "vaultSettings.row.members.hint.one": "1 person",
  "vaultSettings.row.members.hint.many": "{count} people",
  "vaultSettings.row.invite": "Invite member",
  "vaultSettings.row.invite.hint": "Email-anchored invitation",
  "vaultSettings.row.addPhone": "Add a phone",
  "vaultSettings.row.addPhone.hint": "Pair another phone you own",
  "vaultSettings.row.audit": "View audit log",
  "vaultSettings.row.audit.hint.owner": "All Kaata activity",
  "vaultSettings.row.audit.hint.editor": "Your actions",
  "vaultSettings.row.audit.viewerEmpty": "Audit log is not available for viewers.",
  "vaultSettings.row.transfer": "Transfer ownership",
  "vaultSettings.row.leave": "Leave Kaata",
  "vaultSettings.row.archive": "Archive Kaata",
  "vaultSettings.row.unarchive": "Unarchive Kaata",
  "vaultSettings.toast.unarchived": "Kaata unarchived",
  "vaultSettings.toast.unarchiveFailed": "Couldn't unarchive. Try again.",
  "vaultSettings.confirm.archive.title": "Archive this Kaata?",
  "vaultSettings.confirm.archive.body":
    "This Kaata will be hidden for everyone with access. Multi-owner Kaatas need all owners to archive before purge. This cannot be undone after the 30-day grace window.",
  "vaultSettings.confirm.archive.cta": "Archive",
  "vaultSettings.confirm.leave.title": "Leave this Kaata?",
  "vaultSettings.confirm.leave.body.owner":
    "You're an owner. If you're the only one, you'll be asked to transfer ownership or archive this Kaata.",
  "vaultSettings.confirm.leave.body.member":
    "You will lose access to this Kaata's ledger. The owner can re-invite you later.",
  "vaultSettings.confirm.leave.cta": "Leave",
  "vaultSettings.leave.lastOwner.title": "You're the only owner",
  "vaultSettings.leave.lastOwner.body":
    "If you leave, this Kaata will have no admin. You won't be able to invite people, change settings, or archive it later. Archive it instead, or pass ownership to a member first.",
  "vaultSettings.leave.lastOwner.archive": "Archive instead",
  "vaultSettings.leave.lastOwner.transfer": "Transfer ownership",
  "vaultSettings.leave.lastOwner.cancel": "Cancel",
  "vaultSettings.confirm.transfer.title": "Transfer ownership?",
  "vaultSettings.confirm.transfer.body":
    "Pick another member to become the new owner. You'll be demoted to editor unless you also choose to leave.",
  "vaultSettings.confirm.transfer.cta": "Choose member",

  // Vault members — Phase 7 UX critique #8 (translated).
  "members.title": "Members",
  "members.section.members": "Members ({count})",
  "members.section.pending": "Pending invites ({count})",
  "members.empty": "No members yet.",
  "members.youSuffix": " (You)",
  "members.transferBanner": "Tap a member to transfer ownership to them.",
  // D-OFFLINE-ADD-MEMBER + D-UI-UNIFICATION — primary/secondary add-member rows
  "members.row.addMember": "Add member",
  "members.row.addMember.hint": "Show QR for in-person setup — works offline",
  "members.row.sendInvite": "Send invite link",
  "members.row.sendInvite.hint": "Email a join link — requires internet",
  "members.expiresIn.soon": "soon",
  "members.expiresIn.hours": "in {hours}h",
  "members.expiresIn.days": "in {days}d",
  "members.expiresLabel": "Expires {when}",
  "members.toast.noActive": "No active Kaata",
  "members.toast.loadFailed": "Failed to load members",
  "members.toast.roleUpdated": "Role updated",
  "members.toast.cannotChangeSelf": "You can't change your own role.",
  "members.toast.roleFailed": "Failed to change role",
  "members.toast.removed": "Member removed",
  "members.toast.removeFailed": "Failed to remove member",
  // UX critique #2: name the recipient in the success toast — it's both
  // a confirmation-of-correctness signal and feels far less terse than
  // the plain "Ownership transferred" the older copy used.
  "members.toast.transferred": "Ownership transferred to {name}",
  "members.toast.transferFailed": "Failed to transfer",
  // UX critique #6: specific error toasts for the three diagnosable
  // failure modes the router can surface. Each one names the situation
  // so the user understands what to do next.
  "members.toast.transferNotMember":
    "{name} is no longer a member of this Kaata. The list has been refreshed.",
  "members.toast.transferPartialRecovered":
    "Transfer didn't complete. Nothing changed — please try again.",
  "members.toast.transferPartialUnrecovered":
    "Transfer partially landed: there are two owners. Open the menu on one of them to fix this.",
  "members.sheet.title": "Manage {name}",
  "members.sheet.makeEditor": "Make editor",
  "members.sheet.makeViewer": "Make viewer",
  "members.sheet.transfer": "Transfer ownership",
  "members.sheet.remove": "Remove from vault",
  "members.confirm.remove.title": "Remove this member?",
  "members.confirm.remove.body":
    "They will lose access to this vault immediately. Their past contributions stay in the ledger and audit log.",
  "members.confirm.remove.cta": "Remove",
  // UX critique #1: confirm dialog spells out the irreversible
  // consequences ("only they can transfer back", "they control members
  // and settings") and the CTA is a named action ("Make {name} owner")
  // rather than a generic verb. Title also names the recipient so the
  // user can catch the wrong-pick mistake before tapping confirm.
  "members.confirm.transfer.title": "Make {name} the owner?",
  "members.confirm.transfer.body":
    "You'll be demoted to editor. Only {name} will be able to add or remove members, change settings, or transfer ownership back to you. They'll see this the next time their phone syncs.",
  "members.confirm.transfer.fallback": "this member",
  "members.confirm.transfer.cta": "Make {name} owner",
  // Fallback CTA used only when the dialog is mid-dismiss and the target
  // ref was just cleared. UI never normally renders this string.
  "members.confirm.transfer.cta.fallback": "Make owner",

  // Vault invite — Phase 7 UX critique #8 (translated).
  "invite.title": "Invite member",
  "invite.section.invitee": "Invitee",
  "invite.section.role": "Role",
  "invite.section.shareLink": "Share link",
  "invite.email.label": "Email",
  "invite.email.placeholder": "name@example.com",
  "invite.email.required": "Email is required",
  "invite.email.invalid": "Enter a valid email",
  "invite.email.alreadyInvited": "This email is already invited",
  "invite.email.alreadyMember": "This email is already a member",
  "invite.gmailDotHint":
    "The invitee must accept using the same Google email. Gmail addresses are matched without dots.",
  "invite.role.editor": "Editor",
  "invite.role.editor.hint": "Add, edit, and delete entries",
  "invite.role.viewer": "Viewer",
  "invite.role.viewer.hint": "Read-only access",
  "invite.submit": "Create invitation",
  "invite.created": "Invitation created",
  "invite.failed": "Failed to create invitation",
  "invite.ownerOnly": "Only the Kaata owner can invite members.",
  "invite.result.sent": "Invitation sent",
  "invite.result.sub": "{email} · expires {when}",
  "invite.copy": "Copy link",
  "invite.copy.fallback": "Link ready to share",
  "invite.copy.unavailable": "Copy unavailable",
  "invite.share": "Share via…",
  "invite.shareMessage": "Join my Kaata: {url}",
  "invite.again": "Invite someone else",
  "invite.expiresIn.soon": "soon",
  "invite.expiresIn.lessThanDay": "in less than a day",
  "invite.expiresIn.days": "in {days} days",
  "invite.toast.noActive": "No active Kaata",
  // D-UI-UNIFICATION — online/offline disclosure banner + offline fallback CTA
  "invite.online.banner":
    "For people who aren't here in person. To add staff you're with right now, use Add member.",
  "invite.offline.banner":
    "You're offline. Invite links need internet — try Add member for in-person setup.",
  "invite.offline.fallbackCta": "Open Add member instead",
  "invite.signInRequired":
    "Sign in with Google to send email invites. To add staff in person, use Add member.",
  "invite.vaultNotOnServer":
    "This Kaata hasn't synced to the server yet. Sync first to send email invites, or use Add member instead.",

  // Vault audit log — Phase 7 UX critique #8 (translated).
  "auditLog.title": "Activity",
  "auditLog.noViewerAccess": "No audit access for viewers.",
  "auditLog.toast.noActive": "No active Kaata",
  "auditLog.toast.loadFailed": "Failed to load audit log",
  "auditLog.notAvailable.title": "Activity not available",
  "auditLog.notAvailable.body": "This Kaata has no server-side activity log.",
  "auditLog.empty.title": "No activity yet",
  "auditLog.empty.body": "Activity in this Kaata — entries, people, settings — will appear here.",
  "auditLog.endOfHistory": "End of history",
  "auditLog.system": "System",
  "auditLog.kind.inviteIssued": "Invitation sent",
  "auditLog.kind.inviteAccepted": "Invitation accepted",
  "auditLog.kind.roleChanged": "Role changed",
  "auditLog.kind.memberRevoked": "Member removed",
  "auditLog.kind.memberLeft": "Member left",
  "auditLog.kind.vaultArchived": "Kaata archived",
  "auditLog.kind.vaultUnarchived": "Kaata unarchived",
  "auditLog.kind.transferInitiated": "Ownership transfer started",
  "auditLog.kind.transferCompleted": "Ownership transferred",
  // Local-CA event_type → human strings. Previously hardcoded English in
  // audit-log.tsx — now routed through t() so Dari locale renders correctly.
  "auditLog.kind.local.addedMember": "Added member",
  "auditLog.kind.local.addedMemberAs": "Added member as {role}",
  "auditLog.kind.local.roleChangedTo": "Role changed to {role}",
  "auditLog.kind.local.currencyChanged": "Currency changed",
  "auditLog.kind.local.currencyChangedTo": "Currency changed to {value}",
  "auditLog.kind.local.renamed": "Kaata renamed",
  "auditLog.kind.local.renamedTo": "Renamed to {value}",
  "auditLog.kind.local.settingChanged": "Setting changed",
  "auditLog.kind.local.settingChangedKey": "Setting changed: {key}",
  "auditLog.kind.local.shopProfileUpdated": "Shop profile updated",
  "auditLog.kind.local.entryAdded": "Entry added",
  "auditLog.kind.local.entryEdited": "Entry edited",
  "auditLog.kind.local.entryDeleted": "Entry deleted",
  "auditLog.kind.local.personAdded": "Person added",
  "auditLog.kind.local.personRenamed": "Person renamed",
  "auditLog.kind.local.personArchived": "Person archived",
  "auditLog.kind.local.personUnarchived": "Person unarchived",
  "auditLog.target": "target: {id}",
  "auditLog.relative.justNow": "just now",
  "auditLog.relative.minutesAgo": "{n}m ago",
  "auditLog.relative.hoursAgo": "{n}h ago",
  "auditLog.relative.daysAgo": "{n}d ago",
  "auditLog.relative.monthsAgo": "{n}mo ago",
} as const;

type Key = keyof typeof en;

// Afghan Dari translations. Curated for the Kabul / Mazar / Herat shopkeeper
// market — uses Afghan vernacular vocabulary (دکان not مغازه, تلفون not تلفن,
// مخاطب for contact, etc.) rather than Iranian Persian. Western digits (1-9)
// throughout, matching modern Afghan commerce.
//
// Missing keys fall back to English; half-translated UI doesn't break. Add a
// new key here as soon as you add it to the en table.
const fa: Partial<Record<Key, string>> = {
  // Onboarding
  "onboarding.subtitle": "یک دفتر آرام میان شما و کسانی که اعتماد دارید.",
  "onboarding.name.label": "نام شما",
  "onboarding.name.placeholder": "سلطان",
  "onboarding.phone.label": "شماره تلفون (اختیاری)",
  "onboarding.phone.placeholder": "+93 7…",
  "onboarding.phone.hint":
    "برای اینکه کارمندان شما را در مخاطبین خود پیدا کنند. تأیید نمی‌شود و به اشتراک گذاشته نمی‌شود.",
  "onboarding.shop.label": "نام دکان یا تجارت",
  "onboarding.shop.labelOptional": "نام کاتا (اختیاری)",
  "onboarding.shop.placeholder": "دکان سلطان",
  "onboarding.shop.hint":
    "اگر به کاتای موجود می‌پیوندید، رد کنید. بعداً می‌توانید بسازید یا نامگذاری کنید.",
  "onboarding.continue": "ادامه",
  "onboarding.nameRequired": "نام لازم است",

  // Onboarding step 1 — language picker
  "onboardingLanguage.title": "زبان خود را برگزینید",
  "onboardingLanguage.subtitle": "بعداً می‌توانید این را در تنظیمات تغییر دهید.",

  // Onboarding mode picker
  "onboardingMode.title": "می‌خواهید چطور از کاتا استفاده کنید؟",
  "onboardingMode.subtitle": "بعداً می‌توانید این را در تنظیمات تغییر دهید.",
  "onboardingMode.google.title": "ورود با گوگل",
  "onboardingMode.google.body":
    "کاتای خود را در کلاد ذخیره کنید. اگر تلفن گم شد، روی تلفن نو بازیابی کنید.",
  "onboardingMode.offline.title": "بدون حساب",
  "onboardingMode.offline.body": "بدون حساب. کاتای شما فقط روی همین تلفون می‌ماند — کاملاً خصوصی.",
  "onboardingMode.signInFailed": "ورود نشد. دوباره امتحان کنید.",
  "onboardingMode.expoGoHint":
    "ورود در نسخه واقعی برنامه کار می‌کند؛ فعلاً می‌توانید بدون حساب ادامه دهید.",
  "onboardingMode.back": "برگشت",

  // Onboarding profile
  "onboardingProfile.title": "تقریباً تمام",
  "onboardingProfile.signedInHint": "وارد شده به نام {email}",
  "onboardingProfile.continue": "ادامه",
  "onboardingProfile.nameRequired": "لطفاً نام خود را وارد کنید",
  "onboardingProfile.shopRequired": "لطفاً برای کاتای خود نام بگذارید",
  "onboardingProfile.joinExisting": "به جای آن به کاتای موجود می‌پیوندم",

  // Onboarding restore
  "onboardingRestore.title": "کاتای شما پیدا شد",
  "onboardingRestore.subtitle": "آخرین ذخیره در {date}.",
  "onboardingRestore.restore.title": "بازیابی از فضای ابری",
  "onboardingRestore.restore.body": "افراد، ثبت‌ها و فروشگاه خود را روی این تلفن برگردانید.",
  "onboardingRestore.fresh.title": "شروع تازه",
  "onboardingRestore.fresh.body":
    "نسخهٔ ابری را نادیده بگیرید و یک کاتای تمیز روی این تلفن بسازید.",
  "onboardingRestore.restoring": "در حال بازیابی کاتای شما…",
  "onboardingRestore.tryAgain": "دوباره تلاش کنید",
  "onboardingRestore.startFresh": "شروع تازه",
  "onboardingRestore.errorTitle": "بازیابی ممکن نشد",
  "onboardingRestore.errorSessionExpired": "نشست شما منقضی شد. برای بازیابی دوباره وارد شوید.",
  "onboardingRestore.errorTimeout": "شبکه خیلی کند بود. با اتصال بهتر دوباره تلاش کنید.",
  "onboardingRestore.errorGeneric": "مشکلی پیش آمد. دوباره تلاش کنید.",

  // Tour deprecated — keys removed alongside English. See
  // docs/tour-redesign.md for the postmortem.

  // Profile menu — only the live keys remain (Phase 7 D-ACCOUNT-PAGE-ROLE
  // killed the /account screen and its dependent strings).
  "profile.menu.preferences": "تنظیمات",
  "profile.menu.preferencesHint": "زبان، ارز، منطقه",

  // Phase 4.1: "different Google account on this phone?" prompt.
  "account.differentAccount.title": "حساب گوگل متفاوت در این تلفن",
  "account.differentAccount.body":
    "این تلفن در حال حاضر به {oldEmail} متصل است. شما {newEmail} را انتخاب کردید. می‌خواهید چه کار کنید؟",
  "account.differentAccount.keep": "تعویض، نگه داشتن داده‌ها",
  "account.differentAccount.wipe": "تعویض، شروع از نو",
  "account.differentAccount.cancel": "لغو",

  // Preferences screen — section copy
  "preferences.title": "تنظیمات",
  "preferences.currency.section": "ارز",
  "preferences.currency.defaultHint":
    "برای کاتاهای جدید استفاده می‌شود. هر کاتا می‌تواند جداگانه تغییر کند.",
  "preferences.region.section": "منطقه",
  "preferences.country.label": "کشور پیش‌فرض",
  "preferences.country.hint":
    "انتخاب‌گر کشور در افزودن مخاطب جدید از اینجا شروع می‌شود. شماره‌های موجود تغییر نمی‌کند.",
  "preferences.country.changed": "کشور پیش‌فرض به‌روز شد.",
  "preferences.appearance.section": "ظاهر",
  "preferences.appearance.theme": "تم",
  "preferences.appearance.themeHint": "روشن، تاریک یا مطابق سیستم.",
  "preferences.notifications.section": "اعلان‌ها",
  "preferences.notifications.reminders": "یادآوری‌ها",
  "preferences.notifications.remindersHint": "برای حساب‌های تصفیه‌نشده اطلاع بگیرید.",
  "preferences.comingSoon": "به‌زودی",

  // Home
  "home.tab.collect": "وصول",
  "home.tab.pay": "پرداخت",
  "home.total.label.collect": "قابل وصول",
  "home.total.label.pay": "قابل پرداخت",
  "home.empty.collect.title": "هنوز چیزی برای وصول نیست",
  "home.empty.collect.subtitle": "روی دکمه + بزنید تا کسی را اضافه کنید که با او حساب دارید.",
  "home.empty.pay.title": "هنوز از کسی قرضدار نیستید",
  "home.empty.pay.subtitle":
    "وقتی جنس می‌گیرید یا پول قرض می‌کنید، از صفحه آن شخص ثبت کنید — همین‌جا ظاهر می‌شود.",
  "home.from.someone": "از {count} نفر",
  "home.from.many": "از {count} نفر",
  "home.empty.noOneYet": "هنوز کسی نیست",
  "home.empty.allSettled": "همه تصفیه شده",

  // Person detail
  "person.action.iGave": "دادم",
  "person.action.iReceived": "گرفتم",
  "person.balance.theyOwe": "از شما قرضدار",
  "person.balance.youOwe": "از او قرضدار",
  "person.balance.settled": "تصفیه شده",
  "person.empty.title": "هنوز ثبتی نیست",
  "person.empty.subtitle":
    'وقتی پول یا جنس از دست‌تان می‌رود "دادم" را بزنید، وقتی به دست‌تان می‌آید "گرفتم".',
  "person.ping": "یادآوری به {name} در واتساپ",
  "person.delete.title": "این ثبت را حذف کنیم؟",
  "person.delete.description":
    "این مقدار دیگر در حساب این شخص محاسبه نمی‌شود. از اینجا قابل برگشت نیست.",
  "person.delete.confirm": "حذف",
  "person.sheet.edit": "ویرایش",
  "person.sheet.delete": "حذف",
  "person.row.noEntries": "هنوز ثبتی نیست",
  "person.row.settled": "تصفیه",

  // Person edit / add
  "personEdit.title": "ویرایش شخص",
  "personEdit.name.label": "نام",
  "personEdit.phone.label": "شماره واتساپ",
  "personEdit.save": "ذخیره تغییرات",
  "personAdd.title": "افزودن یا یافتن شخص",
  "personAdd.name.placeholder": "برای جستجو یا افزودن تایپ کنید",
  "personAdd.pickContact": "یا از مخاطبین تلفون انتخاب کنید",
  "personAdd.add": "افزودن {name}",
  "personAdd.phone.hint": "برای ارسال یادآوری در واتساپ لازم است.",
  "personAdd.phone.invalid": "این شماره را نتوانستم بخوانم. مثلاً +93 70 123 4567.",
  "personAdd.phone.conflict": "این شماره قبلاً برای {name} ثبت شده",
  "personAdd.section.matches": "نتایج",
  "personAdd.section.recent": "اخیر",
  "personAdd.noMatch": "هیچ‌کس با «{query}» مطابقت نمی‌کند.",
  "personAdd.empty.title": "هنوز کسی نیست",
  "personAdd.empty.subtitle": "نام را در بالا تایپ کنید تا اولین شخص را اضافه کنید.",
  "personAdd.rightAmount.new": "جدید",
  "personAdd.rightAmount.settled": "تصفیه",
  "personAdd.personNotFound": "این شخص پیدا نشد.",

  // Entry
  "entry.amount.label": "مقدار (AFN)",
  "entry.note.label": "یادداشت",
  "entry.note.placeholder": "آرد و چای",
  "entry.save": "ذخیره",
  "entry.saveChanges": "ذخیره تغییرات",
  "entry.context.to": "به",
  "entry.context.from": "از",
  "entry.edit.title": "ویرایش · {verb}",
  "entry.edit.hint":
    'جهت قابل تغییر نیست. برای تبدیل به "{otherVerb}" این ثبت را حذف کنید و یکی نو اضافه کنید.',
  "entry.notFound": "این ثبت دیگر وجود ندارد.",
  "entry.invalidAmount": "یک مقدار درست وارد کنید",
  "entry.noActiveVault": "کاتای فعال وجود ندارد. برای ادامه یک کاتا بسازید.",
  "entry.vaultArchived": "این کاتا بایگانی شده است. آن را بازیابی کنید یا کاتای دیگری انتخاب کنید.",
  "home.fab.blockedArchived":
    "این کاتا بایگانی شده است. آن را بازیابی کنید یا کاتای دیگری انتخاب کنید.",
  "entry.saved": "ثبت شد",
  "entry.updated": "به‌روزرسانی شد",
  "entry.deleted": "حذف شد",
  "entry.saveFailed": "ذخیره نشد. دوباره امتحان کنید.",
  "entry.roleDenied": "فقط مشاهده — از مالک اجازه ویرایشگر بخواهید.",
  "projectionConflicts.toast.roleGate": "نقش شما تغییر کرد — آن تغییر ذخیره نشد.",
  "projectionConflicts.toast.serverRejected":
    "سرور آخرین تغییر شما را نپذیرفت. لطفاً تازه‌سازی کنید.",

  // Settings — only "settings.saved" remains (person/edit auto-save toast).
  "settings.saved": "ذخیره شد",
  "settings.language.label": "زبان",
  "settings.language.option.system": "پیش‌فرض سیستم",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "زبان تغییر کرد.",
  "settings.currency.label": "ارز پیش‌فرض",
  "settings.currency.hint": "این فقط برچسب است. اعداد تغییر نمیکند.",
  "settings.currency.changed": "ارز تغییر کرد.",
  "home.exit.hint": "برای خروج دوباره برگشت را بزنید.",
  "entry.amount.labelTemplate": "مقدار ({code})",

  // Country picker
  "country.title": "انتخاب کشور",
  "country.search": "جستجو بر اساس نام یا کد",
  "country.noMatch": "موردی پیدا نشد.",

  // Contacts picker
  "contacts.title": "انتخاب از مخاطبین",
  "contacts.search": "جستجو بر اساس نام",
  "contacts.permission.title": "دسترسی به مخاطبین لازم است",
  "contacts.permission.body": "از تنظیمات تلفون اجازه دسترسی به مخاطبین را برای کاتا فعال کنید.",
  "contacts.permission.button": "باز کردن تنظیمات",
  "contacts.empty.none": "هیچ مخاطبی روی این تلفون نیست.",
  "contacts.empty.noMatch": "هیچ مخاطبی با «{query}» مطابقت نمی‌کند.",
  "contacts.noPhone": "بدون شماره",

  // WhatsApp share — full message body sent to the customer.
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "کاتای شما در {accountWith}:",
  "share.theyOwe.amount": "🔴 بدهی شما: −{amount} {currency}",
  "share.theyOwe.cta": "لطفاً وقتی توانستید تصفیه کنید.",
  "share.youOwe.header": "کاتای ما:",
  "share.youOwe.amount": "🟢 قرضدار تان هستم: +{amount} {currency}",
  "share.youOwe.cta": "به‌زودی تصفیه می‌کنم.",
  "share.settled.line": "🤝 کاتای ما کاملاً تصفیه شده.",
  "share.settled.cta": "تشکر.",
  "share.footer": "پیام از طرف kaata.af",

  // Brand
  "brand.wordmark": "کاتا.",

  // Relative time formatting.
  "format.justNow": "همین حالا",
  "format.minutesAgo": "{n} دقیقه پیش",
  "format.hoursAgo": "{n} ساعت پیش",
  "format.yesterday": "دیروز",
  "format.daysAgo": "{n} روز پیش",
  "format.weeksAgo": "{n} هفته پیش",

  // Common
  "common.cancel": "لغو",
  "common.back": "برگشت",
  "common.retry": "تلاش دوباره",
  "common.removed": "{name} حذف شد",
  "common.remove": "حذف",
  "common.remove.title": "{name} حذف شود؟",
  "common.remove.description": "از لیست شما حذف می‌شود. ثبت‌های آن‌ها در دستگاه می‌ماند.",

  // Profile sheet (Phase 7) — Persian counterparts. Section labels in
  // normal case; the SectionHeader atom applies textTransform:"uppercase"
  // at render time. Persian has no case so the transform is a no-op
  // for this locale.
  "menu.title.profile": "پروفایل و تنظیمات",
  "menu.title.vaultSwitcher": "تعویض کاتا",
  "menu.thisKaata.settings": "مدیریت این کاتا",
  "menu.allKaatas": "همه کاتاها",
  "menu.allKaatas.empty": "هنوز کاتایی نیست.",
  "menu.allKaatas.empty.withArchived": "کاتای فعال وجود ندارد.",
  "menu.allKaatas.add": "افزودن کاتا",
  "menu.allKaatas.scan": "اسکن کود جفت‌سازی",
  "menu.allKaatas.scan.hint": "از تلفون دیگر به کاتای موجود بپیوندید",
  "menu.allKaatas.switched": "کاتا تغییر کرد",
  "menu.allKaatas.switchFailed": "تغییر کاتا ناکام شد",
  "menu.allKaatas.archived.show": "نمایش بایگانی شده‌ها ({count})",
  "menu.allKaatas.archived.hide": "پنهان کردن بایگانی ({count})",
  "menu.allKaatas.archived.view": "بایگانی شده ({count})",
  "vaultArchived.title": "بایگانی",
  "vaultArchived.empty": "هنوز کاتای بایگانی‌شده‌ای وجود ندارد.",
  "vaultArchived.emptySubtitle": "همه چیز در کاتاهای فعال شما در دسترس است.",
  "vaultArchived.emptyCta": "بازگشت به کاتاها",
  "vaultArchived.restoreButton": "بازیابی",
  "vaultArchived.restoreFromCloud": "بازیابی از فضای ابری",
  "vaultArchived.serverAnchoredHint": "روی سرور ذخیره شده — از پشتیبان ابری بازیابی کنید",
  "vaultArchived.restoredToast": "{name} بازیابی شد",
  "vaultArchived.restoreFailed": "بازیابی کاتا انجام نشد",
  "vaultArchived.unarchiveUnsupported": "برای بازیابی این کاتا از فضای ابری استفاده کنید",
  "vaultArchived.archivedAt": "بایگانی شده {relative}",
  "vaultArchived.relative.justNow": "هم‌اکنون",
  "vaultArchived.relative.minutesAgo": "{n} دقیقه پیش",
  "vaultArchived.relative.hoursAgo": "{n} ساعت پیش",
  "vaultArchived.relative.daysAgo": "{n} روز پیش",
  "vaultArchived.relative.monthsAgo": "{n} ماه پیش",
  "members.singular": "{count} عضو",
  "members.plural": "{count} عضو",
  "vaultPicker.manage": "مدیریت کاتای فعلی",
  "menu.sync": "همگام‌سازی",
  "menu.sync.never": "هنوز همگام نشده",
  "menu.sync.justNow": "همین حالا",
  "menu.sync.minAgo": "{n} دقیقه پیش",
  "menu.sync.hrAgo": "{n} ساعت پیش",
  "menu.sync.dayAgo": "{n} روز پیش",
  "menu.sync.now": "همگام‌سازی حالا",
  "menu.sync.restore": "بازیابی از کلاد",
  "menu.sync.done": "همگام شد ({pulled} دریافت، {pushed} ارسال)",
  "menu.sync.failed": "همگام‌سازی ناکام شد",
  "menu.sync.offline": "به نظر می‌رسد آنلاین نیستید.",
  "menu.sync.header.never": "—",

  // In-app "Restore from cloud" confirm screen (Phase 7).
  "restore.confirm.title": "بازیابی از کلاد؟",
  "restore.confirm.body":
    "همه‌چیز روی این تلفون با نسخهٔ کلاد جایگزین می‌شود. هر تغییری که هنوز همگام نشده از بین می‌رود.",
  "restore.confirm.cta": "جایگزینی داده‌های محلی",
  "restore.confirm.cancel": "لغو",
  "restore.toast.noBackup": "برای این حساب نسخهٔ پشتیبانی در کلاد پیدا نشد.",
  "restore.toast.success": "از کلاد بازیابی شد.",
  "restore.toast.sessionExpired": "خارج شدید. برای بازیابی دوباره وارد شوید.",
  "restore.toast.timeout": "بازیابی به وقفه خورد. اتصال خود را بررسی کنید.",
  "restore.toast.generic": "بازیابی ناکام شد.",
  // Phase 6: BLE-primary copy. Persian uses "بلوتوث" (Bluetooth) — it's a
  // loanword every Afghan shopkeeper recognizes; "اینترنت/وای‌فای نیاز ندارد"
  // makes the no-connectivity benefit explicit.
  "menu.sync.shopMode": "همگام‌سازی با تلفون‌های نزدیک",
  "menu.sync.shopMode.hint": "از طریق بلوتوث کار می‌کند — به وای‌فای یا اینترنت نیاز ندارد.",
  "menu.sync.shopMode.hintWithPeers": "{count} تلفون نزدیک",
  "menu.sync.shopMode.hintOnePeer": "۱ تلفون نزدیک",
  "menu.sync.shopMode.hintLooking": "در حال یافتن تلفون‌های نزدیک…",
  "menu.sync.shopMode.startedToast": "همگام‌سازی نزدیک روشن.",
  "menu.sync.shopMode.failed": "تغییر همگام‌سازی نزدیک ناکام شد.",
  "menu.sync.shopMode.fgsFailed":
    "همگام‌سازی نزدیک شروع نشد — لطفاً اجازه اعلان‌ها را بدهید و دوباره امتحان کنید.",
  "menu.ble.permRationale.title": "اجازه بلوتوث برای یافتن تلفون‌های نزدیک",
  "menu.ble.permRationale.body":
    "کاتا از بلوتوث برای یافتن تلفون دیگر شما و تلفون‌های کارمندان دکان استفاده می‌کند. اینترنت لازم نیست. ما هیچ‌گاه موقعیت شما را به اشتراک نمی‌گذاریم.",
  "menu.ble.permRationale.continue": "ادامه",
  "menu.ble.permRationale.cancel": "حالا نه",
  "menu.ble.permDenied.title": "اجازهٔ بلوتوث لازم است",
  "menu.ble.permDenied.body":
    "همگام‌سازی نزدیک برای یافتن تلفون‌های دیگر شما به اجازهٔ بلوتوث نیاز دارد. تنظیمات را باز کنید؟",
  "menu.ble.permDenied.openSettings": "باز کردن تنظیمات",
  "menu.ble.permDenied.cancel": "حالا نه",
  "menu.ble.unsupported": "این تلفون نمی‌تواند بلوتوث ارسال کند — همگام‌سازی نزدیک کار نخواهد کرد.",
  "menu.ble.adapterOff": "بلوتوث خاموش است. برای همگام‌سازی روشن کنید.",
  "menu.ble.peripheralUnsupported":
    "تلفون شما نمی‌تواند به دیگران ارسال کند، اما همچنان می‌تواند تلفون‌های نزدیک کاتا را پیدا کند. از تلفون دیگر بخواهید همگام‌سازی نزدیک را روشن کند.",
  "menu.ble.peerHandshakeFailed":
    "اتصال به یک تلفون نزدیک ناکام شد. ممکن است از کاتای دیگر باشد یا نشست‌شان منقضی شده باشد.",
  "menu.ble.peerDecryptFailed": "ارتباط با تلفون نزدیک قطع شد. در حال تلاش دوباره.",
  // Battery-optimization prompt
  "menu.battery.title": "یک قدم آخر: اجازهٔ پس‌زمینه",
  "menu.battery.description":
    "همگام‌سازی نزدیک نیاز دارد که اندروید اجازه دهد بلوتوث کاتا حتی وقت قفل بودن تلفون فعال بماند. بعد: تنظیمات ← باتری ← بدون محدودیت.",
  "menu.battery.confirm": "باز کردن تنظیمات",
  "menu.battery.skip": "رد کردن — همگام‌سازی نزدیک خاموش",
  "wifiUpgrade.title": "همگام‌سازی ~{count} ثبت — حدود {min} دقیقه با بلوتوث",
  "wifiUpgrade.body": "هر دو تلفون را به یک وای‌فای وصل کنید تا در چند ثانیه تمام شود.",
  "wifiUpgrade.tryWifi": "امتحان وای‌فای",
  "wifiUpgrade.stayBle": "ادامه با بلوتوث",
  "wifiUpgrade.cancel": "توقف همگام‌سازی",
  "wifiUpgrade.toast.switched": "به وای‌فای منتقل شد — سریع‌تر",
  "wifiUpgrade.toast.fallback": "اتصال وای‌فای ناکام، با بلوتوث ادامه می‌دهیم",
  "wifiUpgrade.toast.autoDismissed": "با بلوتوث ادامه می‌دهیم",
  "wifiUpgrade.toast.searching": "در حال یافتن تلفون دیگر روی وای‌فای…",
  "menu.account": "حساب",
  "menu.account.signIn": "ورود با گوگل",
  "menu.account.signIn.toast": "ورود انجام شد",
  "menu.account.signIn.failed": "ورود ناموفق — دوباره کوشش کنید",
  "menu.account.signOut": "خروج",
  "menu.account.signOut.toast": "خروج انجام شد",
  "menu.account.signOut.failed": "خروج ناموفق — دوباره کوشش کنید",
  "menu.account.signOut.confirm.title": "خارج می‌شوید؟",
  "menu.account.signOut.confirm.body":
    "از حساب {email} خارج می‌شوید. کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.bodyGeneric":
    "کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.cta": "خروج",
  "menu.account.switch": "تعویض حساب گوگل",
  "menu.account.localOnlyHint": "برای پشتیبان‌گیری و همگام‌سازی بین تلفون‌ها وارد شوید.",
  "menu.about": "درباره",
  "menu.about.versionLine": "نسخه {version}",
  "menu.about.versionLineWithBuild": "نسخه {version} · بیلد {build}",

  // Vault create (Phase 5.2)
  "vaultNew.title": "ایجاد کاتای جدید",
  "vaultNew.titleForced": "برای ادامه یک کاتا بسازید",
  "vaultNew.name.label": "نام کاتا",
  "vaultNew.name.placeholder": "دکان جدید من",
  "vaultNew.name.required": "نام لازم است",
  "vaultNew.currency.label": "ارز",
  "vaultNew.currency.hint": "پیش‌فرض برای تمام مبالغ این کاتا. بعداً در تنظیمات قابل تغییر است.",
  "vaultNew.localOnlyHint": "وارد نشده‌اید. این کاتا فقط روی همین تلفون می‌ماند تا وقتی وارد شوید.",
  "vaultNew.submit": "ایجاد کاتا",
  "vaultNew.created": "{name} ایجاد شد",
  "vaultNew.failed": "ایجاد کاتا ناکام شد",

  // Vault pair (owner side)
  "vaultPair.title": "افزودن تلفون به این کاتا",
  "vaultPair.headline": "افزودن تلفون دیگر به",
  "vaultPair.instructions.local":
    "روی تلفون دیگر (همانی که می‌خواهید اضافه کنید):\n" +
    "۱. کاتا را باز کنید.\n" +
    "۲. آیکن پروفایل (بالا-راست) → افزودن کاتا → اسکن کود جفت‌سازی.\n" +
    "۳. دوربین را روی کود زیر بگیرید.",
  "vaultPair.instructions.server":
    "روی تلفون دیگر (همانی که می‌خواهید اضافه کنید):\n" +
    "۱. با همان حساب گوگل وارد شوید.\n" +
    "۲. آیکن پروفایل (بالا-راست) → افزودن کاتا → اسکن کود جفت‌سازی.\n" +
    "۳. دوربین را روی کود زیر بگیرید.",
  "vaultPair.codeExpired": "کود منقضی شد",
  "vaultPair.generating": "در حال ساخت…",
  "vaultPair.expiresIn": "انقضا در {time}",
  "vaultPair.generateNew": "کود جدید بسازید",
  "vaultPair.sendLink": "به جای آن لینک بفرستید",
  "vaultPair.sendLink.opening": "در حال باز کردن…",
  "vaultPair.shareLinkMessage": "جفت‌سازی تلفون دیگرم با کاتا: {url}",
  "vaultPair.shareLinkReady": "لینک آماده اشتراک",
  "vaultPair.shareLinkFailed": "اشتراک لینک ناکام شد",
  "vaultPair.noActiveKaata": "کاتای فعال نیست",
  "vaultPair.vaultNotFound": "کاتا پیدا نشد",
  "vaultPair.signInFirst": "ابتدا وارد شوید تا تلفون جفت کنید",
  "vaultPair.loadFailed": "بار کردن جفت‌سازی ناکام شد",
  "vaultPair.fineprint.local":
    "تلفون دیگر نیاز ندارد وارد شود — جفت‌سازی مستقیم بین دو تلفون از طریق بلوتوث است.",
  "vaultPair.fineprint.server":
    "تلفون دیگر باید با همان حساب گوگل این یکی وارد شده باشد. برای دعوت دیگری (حساب گوگل دیگر)، از «دعوت عضو» استفاده کنید.",
  // D-PAIR-WITH-ROLE — role picker (Persian)
  "vaultPair.role.title": "نقش این تلفون را در",
  "vaultPair.role.subtitle":
    "انتخاب کنید تلفون دیگر پس از جفت‌سازی چه اجازاتی داشته باشد. بعداً قابل تغییر است.",
  "vaultPair.role.owner": "مالک",
  "vaultPair.role.owner.body":
    "کنترل کامل. می‌تواند اعضا را اضافه یا حذف کند، نقش‌ها را تغییر دهد و همه چیز را ویرایش کند.",
  "vaultPair.role.editor": "ویرایشگر",
  "vaultPair.role.editor.body":
    "کارمند روزمره. می‌تواند ورودی‌ها را اضافه و ویرایش کند، اما اعضا را مدیریت نمی‌کند.",
  "vaultPair.role.viewer": "بیننده",
  "vaultPair.role.viewer.body":
    "فقط مشاهده. می‌تواند موجودی‌ها و ورودی‌ها را ببیند ولی چیزی را تغییر نمی‌دهد.",
  "vaultPair.role.continue": "نمایش کود جفت‌سازی",
  "vaultPair.role.committed": "این کود نقش زیر را می‌دهد: {role}",

  // Vault pair (scanner side)
  "vaultPairScan.title": "اسکن کود جفت‌سازی",
  "vaultPairScan.permission.headline": "دسترسی دوربین لازم است",
  "vaultPairScan.permission.body":
    "کاتا برای اسکن کود جفت‌سازی روی تلفون دیگر به دوربین نیاز دارد. هیچ عکسی ذخیره یا فرستاده نمی‌شود.",
  "vaultPairScan.permission.allow": "اجازه دادن به دوربین",
  "vaultPairScan.scanning.hint": "دوربین را روی کود QR که تلفون دیگر نشان می‌دهد بگیرید",
  "vaultPairScan.confirm.prefix": "پیوستن به",
  "vaultPairScan.confirm.body.local":
    "این تلفون به عنوان تلفون دوم این کاتا اضافه می‌شود. وقتی دو تلفون نزدیک هم باشند با بلوتوث همگام می‌شوند — انترنت لازم نیست.",
  "vaultPairScan.confirm.body.server":
    "این تلفون به عنوان تلفون دوم این کاتا اضافه می‌شود. ورودی‌ها از طریق انترنت همگام می‌شوند و وقتی دو تلفون نزدیک هم باشند، مستقیم هم.",
  "vaultPairScan.confirm.join": "پیوستن به کاتا",
  "vaultPairScan.confirm.rescan": "اسکن دوباره",
  "vaultPairScan.joining": "در حال پیوستن به {name}…",
  "vaultPairScan.joined.headline": "جفت شد با",
  "vaultPairScan.joined.body.local":
    "وقتی دو تلفون نزدیک هم باشند با بلوتوث همگام می‌شوند. همگام‌سازی نزدیک روشن شد.",
  "vaultPairScan.joined.body.server":
    "دو تلفون با انترنت و نیز با بلوتوث در صورت نزدیکی همگام می‌شوند. همگام‌سازی نزدیک روشن شد.",
  "vaultPairScan.toast.pairedNearby": "جفت شد — در حال همگام‌سازی نزدیک",
  "vaultPairScan.error.headline": "جفت‌سازی ناکام شد",
  "vaultPairScan.error.signInRequired": "ابتدا با همان حساب گوگل تلفون دیگر وارد شوید.",
  "vaultPairScan.error.accountMismatch":
    "این کود برای حساب گوگل دیگری ساخته شده. از مالک بخواهید دعوت ایمیلی بفرستد.",
  "vaultPairScan.error.generic": "جفت‌سازی ناکام شد",
  "vaultPairScan.error.expired": "این کود جفت‌سازی منقضی شده. از مالک بخواهید کود جدید بسازد.",
  "vaultPairScan.error.unsupported":
    "این کود از نسخه جدیدتر کاتا است. اپ را به‌روز کنید و دوباره کوشش کنید.",
  "vaultPairScan.error.malformed":
    "خواندن این کود ناکام شد. مطمئن شوید کود جفت‌سازی کاتا را اسکن کرده‌اید.",
  // D-PAIR-WITH-ROLE — confirmation role surfacing (Persian)
  "vaultPairScan.confirm.asRole": "به عنوان {role}",
  "vaultPairScan.confirm.roleMissing": "نقش در این کود مشخص نشده — به عنوان ویرایشگر می‌پیوندید.",

  "common.done": "تمام",
  "common.loading": "بارگیری…",
  "common.tryAgain": "دوباره کوشش",

  // Vault settings — Persian
  "vaultSettings.title": "تنظیمات کاتا",
  "vaultSettings.role.owner": "مالک",
  "vaultSettings.role.editor": "ویرایشگر",
  "vaultSettings.role.viewer": "بیننده",
  "vaultSettings.section.details": "مشخصات",
  "vaultSettings.section.members": "اعضا",
  "vaultSettings.section.activity": "فعالیت",
  "vaultSettings.section.danger": "ناحیه خطرناک",
  "vaultSettings.section.membership": "عضویت",
  "vaultSettings.name.label": "نام کاتا",
  "vaultSettings.name.required": "نام لازم است",
  "vaultSettings.currency.label": "ارز",
  "vaultSettings.viewOnly": "فقط مشاهده — اجازه مالک لازم است.",
  "vaultSettings.toast.noActive": "کاتای فعال نیست",
  "vaultSettings.toast.notFound": "کاتا پیدا نشد",
  "vaultSettings.toast.loadFailed": "بار کردن کاتا ناکام شد",
  "vaultSettings.toast.saved": "نام کاتا تغییر کرد",
  "vaultSettings.toast.saveFailed": "نام ذخیره نشد. دوباره امتحان کنید.",
  "vaultSettings.toast.currencyUpdated": "ارز به‌روز شد",
  "vaultSettings.toast.currencyFailed": "به‌روزرسانی ارز ناکام شد",
  "vaultSettings.toast.archived": "کاتا بایگانی شد",
  "vaultSettings.toast.archiveFailed": "بایگانی ناکام شد",
  "vaultSettings.archive.success": "کاتا بایگانی شد",
  "vaultSettings.archive.successSwitched": "{old} بایگانی شد. به {name} تغییر یافت.",
  "vaultSettings.archive.successNeedNew": "کاتا بایگانی شد. برای ادامه یک کاتای جدید بسازید.",
  "vaultSettings.archive.successNeedRestore": "کاتا بایگانی شد. برای ادامه یکی را بازیابی کنید.",
  "vaultSettings.toast.left": "از کاتا خارج شدید",
  "vaultSettings.toast.leaveFailed": "خروج ناکام شد",
  "vaultSettings.row.members": "اعضا",
  "vaultSettings.row.members.hint.one": "۱ نفر",
  "vaultSettings.row.members.hint.many": "{count} نفر",
  "vaultSettings.row.invite": "دعوت عضو",
  "vaultSettings.row.invite.hint": "دعوت با ایمیل",
  "vaultSettings.row.addPhone": "افزودن تلفون",
  "vaultSettings.row.addPhone.hint": "جفت‌سازی تلفون دیگر شما",
  "vaultSettings.row.audit": "مشاهده گزارش فعالیت",
  "vaultSettings.row.audit.hint.owner": "همه فعالیت‌های کاتا",
  "vaultSettings.row.audit.hint.editor": "اقدامات شما",
  "vaultSettings.row.audit.viewerEmpty": "گزارش فعالیت برای بینندگان فعال نیست.",
  "vaultSettings.row.transfer": "انتقال مالکیت",
  "vaultSettings.row.leave": "خروج از کاتا",
  "vaultSettings.row.archive": "بایگانی کاتا",
  "vaultSettings.row.unarchive": "خروج کاتا از بایگانی",
  "vaultSettings.toast.unarchived": "کاتا از بایگانی خارج شد",
  "vaultSettings.toast.unarchiveFailed": "خروج از بایگانی ناکام شد. دوباره امتحان کنید.",
  "vaultSettings.confirm.archive.title": "این کاتا بایگانی شود؟",
  "vaultSettings.confirm.archive.body":
    "این کاتا برای همه افراد مجاز پنهان می‌شود. کاتاهای چندمالکی باید همه مالکان بایگانی کنند تا پاکسازی شود. پس از ۳۰ روز قابل برگشت نیست.",
  "vaultSettings.confirm.archive.cta": "بایگانی",
  "vaultSettings.confirm.leave.title": "از این کاتا خارج شوید؟",
  "vaultSettings.confirm.leave.body.owner":
    "شما مالک هستید. اگر تنها مالک باشید، از شما خواسته می‌شود مالکیت را منتقل کنید یا این کاتا را بایگانی کنید.",
  "vaultSettings.confirm.leave.body.member":
    "دسترسی شما به دفتر این کاتا قطع می‌شود. مالک می‌تواند بعداً شما را دوباره دعوت کند.",
  "vaultSettings.confirm.leave.cta": "خروج",
  "vaultSettings.leave.lastOwner.title": "شما تنها مالک هستید",
  "vaultSettings.leave.lastOwner.body":
    "اگر خارج شوید، این کاتا هیچ مدیری نخواهد داشت. نمی‌توانید کسی را دعوت کنید، تنظیمات را تغییر دهید یا بعداً بایگانی کنید. به‌جای آن بایگانی کنید، یا اول مالکیت را به یک عضو منتقل کنید.",
  "vaultSettings.leave.lastOwner.archive": "بایگانی شود",
  "vaultSettings.leave.lastOwner.transfer": "انتقال مالکیت",
  "vaultSettings.leave.lastOwner.cancel": "لغو",
  "vaultSettings.confirm.transfer.title": "مالکیت منتقل شود؟",
  "vaultSettings.confirm.transfer.body":
    "عضو دیگری را به عنوان مالک جدید انتخاب کنید. شما به ویرایشگر تبدیل می‌شوید مگر این‌که خروج را نیز انتخاب کنید.",
  "vaultSettings.confirm.transfer.cta": "انتخاب عضو",

  // Members — Persian
  "members.title": "اعضا",
  "members.section.members": "اعضا ({count})",
  "members.section.pending": "دعوت‌های در انتظار ({count})",
  "members.empty": "هنوز عضوی نیست.",
  "members.youSuffix": " (شما)",
  "members.transferBanner": "برای انتقال مالکیت روی یک عضو ضربه بزنید.",
  // D-OFFLINE-ADD-MEMBER + D-UI-UNIFICATION — primary/secondary add-member rows (Persian)
  "members.row.addMember": "افزودن عضو",
  "members.row.addMember.hint": "نمایش کیو-آر برای راه‌اندازی حضوری — بدون اینترنت کار می‌کند",
  "members.row.sendInvite": "ارسال لینک دعوت",
  "members.row.sendInvite.hint": "ارسال لینک پیوستن از طریق ایمیل — به اینترنت نیاز دارد",
  "members.expiresIn.soon": "به زودی",
  "members.expiresIn.hours": "در {hours} ساعت",
  "members.expiresIn.days": "در {days} روز",
  "members.expiresLabel": "انقضا {when}",
  "members.toast.noActive": "کاتای فعال نیست",
  "members.toast.loadFailed": "بار کردن اعضا ناکام شد",
  "members.toast.roleUpdated": "نقش به‌روز شد",
  "members.toast.cannotChangeSelf": "شما نمی‌توانید نقش خود را تغییر دهید.",
  "members.toast.roleFailed": "تغییر نقش ناکام شد",
  "members.toast.removed": "عضو حذف شد",
  "members.toast.removeFailed": "حذف عضو ناکام شد",
  "members.toast.transferred": "مالکیت به {name} منتقل شد",
  "members.toast.transferFailed": "انتقال ناکام شد",
  "members.toast.transferNotMember": "{name} دیگر عضو این کاتا نیست. لیست تازه‌سازی شد.",
  "members.toast.transferPartialRecovered":
    "انتقال کامل نشد. هیچ تغییری اعمال نشد — لطفاً دوباره تلاش کنید.",
  "members.toast.transferPartialUnrecovered":
    "انتقال نیمه‌انجام شد: اکنون دو مالک وجود دارد. روی یکی از آن‌ها ضربه بزنید تا اصلاح شود.",
  "members.sheet.title": "مدیریت {name}",
  "members.sheet.makeEditor": "ویرایشگر کردن",
  "members.sheet.makeViewer": "بیننده کردن",
  "members.sheet.transfer": "انتقال مالکیت",
  "members.sheet.remove": "حذف از کاتا",
  "members.confirm.remove.title": "این عضو حذف شود؟",
  "members.confirm.remove.body":
    "دسترسی او به این کاتا فوراً قطع می‌شود. سهم‌های گذشته در دفتر و گزارش فعالیت می‌ماند.",
  "members.confirm.remove.cta": "حذف",
  "members.confirm.transfer.title": "{name} مالک شود؟",
  "members.confirm.transfer.body":
    "شما به ویرایشگر تبدیل می‌شوید. فقط {name} می‌تواند اعضا را اضافه یا حذف کند، تنظیمات را تغییر دهد یا مالکیت را به شما بازگرداند. ایشان در همگام‌سازی بعدی این تغییر را خواهد دید.",
  "members.confirm.transfer.fallback": "این عضو",
  "members.confirm.transfer.cta": "{name} مالک شود",
  "members.confirm.transfer.cta.fallback": "مالک شود",

  // Invite — Persian
  "invite.title": "دعوت عضو",
  "invite.section.invitee": "دعوت‌شده",
  "invite.section.role": "نقش",
  "invite.section.shareLink": "لینک اشتراک",
  "invite.email.label": "ایمیل",
  "invite.email.placeholder": "name@example.com",
  "invite.email.required": "ایمیل لازم است",
  "invite.email.invalid": "یک ایمیل معتبر وارد کنید",
  "invite.email.alreadyInvited": "این ایمیل قبلاً دعوت شده",
  "invite.email.alreadyMember": "این ایمیل قبلاً عضو است",
  "invite.gmailDotHint":
    "دعوت‌شده باید با همان ایمیل گوگل بپذیرد. آدرس‌های جیمیل بدون نقطه مطابقت می‌شوند.",
  "invite.role.editor": "ویرایشگر",
  "invite.role.editor.hint": "افزودن، ویرایش و حذف ثبت‌ها",
  "invite.role.viewer": "بیننده",
  "invite.role.viewer.hint": "دسترسی فقط‌خواندنی",
  "invite.submit": "ایجاد دعوت",
  "invite.created": "دعوت ایجاد شد",
  "invite.failed": "ایجاد دعوت ناکام شد",
  "invite.ownerOnly": "فقط مالک کاتا می‌تواند عضو دعوت کند.",
  "invite.result.sent": "دعوت ارسال شد",
  "invite.result.sub": "{email} · انقضا {when}",
  "invite.copy": "کپی لینک",
  "invite.copy.fallback": "لینک آماده اشتراک",
  "invite.copy.unavailable": "کپی ممکن نیست",
  "invite.share": "اشتراک از طریق…",
  "invite.shareMessage": "به کاتای من بپیوندید: {url}",
  "invite.again": "دعوت شخص دیگری",
  "invite.expiresIn.soon": "به زودی",
  "invite.expiresIn.lessThanDay": "در کمتر از یک روز",
  "invite.expiresIn.days": "در {days} روز",
  "invite.toast.noActive": "کاتای فعال نیست",
  // D-UI-UNIFICATION — online/offline disclosure banner + fallback CTA (Persian)
  "invite.online.banner":
    "برای کسانی که حضوراً حاضر نیستند. برای افزودن کارمندی که با شما است از «افزودن عضو» استفاده کنید.",
  "invite.offline.banner":
    "آفلاین هستید. لینک‌های دعوت به اینترنت نیاز دارند — برای راه‌اندازی حضوری از «افزودن عضو» استفاده کنید.",
  "invite.offline.fallbackCta": "به جای آن «افزودن عضو» را باز کنید",
  "invite.signInRequired":
    "برای ارسال دعوت با ایمیل، با گوگل وارد شوید. برای افزودن حضوری از «افزودن عضو» استفاده کنید.",
  "invite.vaultNotOnServer":
    "این کاتا هنوز با سرور همگام نشده است. ابتدا همگام کنید یا از «افزودن عضو» استفاده کنید.",

  // Audit log — Persian
  "auditLog.title": "فعالیت",
  "auditLog.noViewerAccess": "دسترسی گزارش فعالیت برای بینندگان نیست.",
  "auditLog.toast.noActive": "کاتای فعال نیست",
  "auditLog.toast.loadFailed": "بار کردن گزارش فعالیت ناکام شد",
  "auditLog.notAvailable.title": "گزارش فعالیت در دسترس نیست",
  "auditLog.notAvailable.body": "این کاتا گزارش فعالیت سمت سرور ندارد.",
  "auditLog.empty.title": "هنوز فعالیتی نیست",
  "auditLog.empty.body": "فعالیت در این کاتا — ثبت‌ها، افراد و تنظیمات — در اینجا ظاهر می‌شود.",
  "auditLog.endOfHistory": "پایان تاریخچه",
  "auditLog.system": "سیستم",
  "auditLog.kind.inviteIssued": "دعوت ارسال شد",
  "auditLog.kind.inviteAccepted": "دعوت پذیرفته شد",
  "auditLog.kind.roleChanged": "نقش تغییر کرد",
  "auditLog.kind.memberRevoked": "عضو حذف شد",
  "auditLog.kind.memberLeft": "عضو خارج شد",
  "auditLog.kind.vaultArchived": "کاتا بایگانی شد",
  "auditLog.kind.vaultUnarchived": "کاتا از بایگانی خارج شد",
  "auditLog.kind.transferInitiated": "انتقال مالکیت آغاز شد",
  "auditLog.kind.transferCompleted": "مالکیت منتقل شد",
  "auditLog.kind.local.addedMember": "عضو افزوده شد",
  "auditLog.kind.local.addedMemberAs": "عضو افزوده شد به‌عنوان {role}",
  "auditLog.kind.local.roleChangedTo": "نقش به {role} تغییر کرد",
  "auditLog.kind.local.currencyChanged": "ارز تغییر کرد",
  "auditLog.kind.local.currencyChangedTo": "ارز به {value} تغییر کرد",
  "auditLog.kind.local.renamed": "نام کاتا تغییر کرد",
  "auditLog.kind.local.renamedTo": "تغییر نام به {value}",
  "auditLog.kind.local.settingChanged": "تنظیم تغییر کرد",
  "auditLog.kind.local.settingChangedKey": "تنظیم تغییر کرد: {key}",
  "auditLog.kind.local.shopProfileUpdated": "مشخصات دکان به‌روز شد",
  "auditLog.kind.local.entryAdded": "ثبت افزوده شد",
  "auditLog.kind.local.entryEdited": "ثبت ویرایش شد",
  "auditLog.kind.local.entryDeleted": "ثبت حذف شد",
  "auditLog.kind.local.personAdded": "نفر افزوده شد",
  "auditLog.kind.local.personRenamed": "نام نفر تغییر کرد",
  "auditLog.kind.local.personArchived": "نفر بایگانی شد",
  "auditLog.kind.local.personUnarchived": "نفر از بایگانی خارج شد",
  "auditLog.target": "هدف: {id}",
  "auditLog.relative.justNow": "همین حالا",
  "auditLog.relative.minutesAgo": "{n} دقیقه پیش",
  "auditLog.relative.hoursAgo": "{n} ساعت پیش",
  "auditLog.relative.daysAgo": "{n} روز پیش",
  "auditLog.relative.monthsAgo": "{n} ماه پیش",
};

const TABLES = { en, fa } as const;
type LocaleCode = keyof typeof TABLES;

// Active locale, computed once at module load. The current launch's strings
// reflect this. When we add a manual override toggle, this will read from
// app_meta first.
function pickLocale(): LocaleCode {
  const first = getLocales()[0];
  const lang = (first?.languageCode ?? "en").toLowerCase();
  // Dari (prs) and Persian (fa) both use the `fa` table.
  if (lang === "fa" || lang === "prs") return "fa";
  return "en";
}

let currentLocale: LocaleCode = pickLocale();

// Subscribers for live locale updates. lib/direction.ts uses this to flip
// the layout direction when the user picks a new language in Settings —
// any component using useIsRTL() (or useLocale()) re-renders without an
// app restart. Notifications fire AFTER currentLocale is updated, so a
// subscriber's callback can re-read getLocale() and see the new value.
const localeListeners = new Set<() => void>();

function notifyLocaleChange(): void {
  // Snapshot the set so a listener that unsubscribes itself during
  // notification doesn't mutate the iteration target.
  for (const fn of [...localeListeners]) {
    try {
      fn();
    } catch (err) {
      // Listener bugs shouldn't break other listeners. Log and continue.
      console.warn("[i18n] locale listener threw", err);
    }
  }
}

export function subscribeLocale(fn: () => void): () => void {
  localeListeners.add(fn);
  return () => {
    localeListeners.delete(fn);
  };
}

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function isPersianScript(): boolean {
  return currentLocale === "fa";
}

export type LocalePref = "system" | LocaleCode;

// Read the stored override from app_meta and apply it. Called by _layout.tsx
// during the async init phase, before the app reaches first render. If no
// override is set (or the value is 'system'), currentLocale stays at whatever
// pickLocale() chose at module load (the device locale).
//
// We notify subscribers after applying — the typical caller is the init
// effect, which runs BEFORE first render, so no consumers exist yet and the
// notify is a no-op. It's still correct to notify in case anything has
// already subscribed (e.g., a future provider that mounts above the gate).
export async function initLocaleFromPref(): Promise<void> {
  try {
    const pref = (await getAppMeta("locale_pref")) as LocalePref | null;
    if (pref === "en" || pref === "fa") {
      if (currentLocale !== pref) {
        currentLocale = pref;
        notifyLocaleChange();
      }
    }
    // 'system' or null → leave at device locale.
  } catch {
    // app_meta unreadable — fall back to device locale silently.
  }
}

// Imperatively change the active locale. Strings update on the next render
// for any component that reads them through t(). Caller is responsible for
// also persisting the choice (see setLocalePref in db.ts via app_meta).
//
// Subscribers (via subscribeLocale) are notified after the update — this is
// how lib/direction.ts's useIsRTL() re-renders consumers when language
// switches in Settings.
export function setLocale(pref: LocalePref): void {
  const next: LocaleCode = pref === "system" ? pickLocale() : pref;
  if (currentLocale === next) return;
  currentLocale = next;
  notifyLocaleChange();
}

// Look up a string for the active locale. Falls back to English if the key
// is missing from the localized table (e.g., during partial translation).
// `vars` substitutes `{placeholder}` tokens with their string values.
export function t(key: Key, vars?: Record<string, string | number>): string {
  const localized = TABLES[currentLocale][key];
  const template = (localized && localized.length > 0 ? localized : en[key]) ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}

// Re-evaluate the locale after the user (eventually) toggles a manual
// override. Currently device-driven only.
export function refreshLocale(): void {
  currentLocale = pickLocale();
}
