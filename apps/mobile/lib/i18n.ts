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
  "onboarding.lastName.label": "Last name",
  "onboarding.lastName.placeholder": "Ahmadi",
  "onboarding.phone.label": "Phone number",
  "onboarding.phone.required": "Phone number is required",
  "onboarding.phone.hint":
    "Used so staff can find you in their contacts when pairing. Not verified, not shared.",
  "onboarding.continue": "Continue",
  "onboarding.nameRequired": "Name required",
  // Fallback display name for a self identity reconstructed during cloud restore
  // when neither the Google name nor the restored owner name is available (rare).
  "recovery.selfPlaceholderName": "You",

  // Onboarding step 1 — language picker. Only shown when device locale
  // isn't already Persian/Dari.
  "onboardingLanguage.title": "Choose your language",
  "onboardingLanguage.subtitle": "You can change this later in Settings.",

  // Onboarding mode picker (step 2 — appears after name + shop)
  "onboardingMode.title": "How would you like to use kaata?",
  "onboardingMode.subtitle": "You can change this later in Settings.",
  // The two offers are explained ONCE each, above their buttons — the backup
  // sentence used to be duplicated on the Google and Apple cards.
  "onboardingMode.account.label": "Back up online",
  "onboardingMode.account.body":
    "Sign in to keep a copy of your kaata in the cloud — restore it on a new phone, and use the same kaata on more than one phone.",
  "onboardingMode.google.title": "Sign in with Google",
  "onboardingMode.apple.title": "Sign in with Apple",
  "onboardingMode.offline.label": "No account",
  "onboardingMode.offline.body": "Your kaata never leaves this phone — private by default.",
  "onboardingMode.offline.title": "Stay fully offline",
  "onboardingMode.signInFailed": "Sign-in didn't work. Try again.",
  "onboardingMode.expoGoHint": "Sign-in works on the real app; for now you can continue offline.",
  "onboardingMode.back": "Back",

  // Onboarding profile (last step before the tour)
  // Was "Almost done" — mistimed once the kaata step landed after this
  // screen, and it described progress instead of saying what the screen IS.
  "onboardingProfile.title": "Introduce yourself",
  "onboardingProfile.subtitle":
    "Your name and number — so the people you keep accounts with know it's you.",
  "onboardingProfile.signedInHint": "Signed in as {email}",
  "onboardingProfile.continue": "Continue",
  "onboardingProfile.nameRequired": "Please enter your name",
  "onboardingProfile.shopRequired": "Please name your Kaata",
  "onboardingProfile.joinExisting": "I'll join an existing kaata instead",

  // Onboarding kaata step (app/onboarding/kaata.tsx) — name the shop + pick a
  // currency, then mint the shopkeeper's first vault. Shop-framed so users
  // don't mistake "a kaata" for a single customer's tab.
  "onboardingKaata.title": "Set up your shop",
  "onboardingKaata.subtitle":
    "Your kaata is your shop's ledger book. Name it so you can keep everyone's accounts in one place.",
  "onboardingKaata.name.label": "Shop name",
  "onboardingKaata.name.placeholder": "Ahmad Grocery Store",
  "onboardingKaata.name.required": "Shop name is required",
  "onboardingKaata.currency.label": "Currency",
  "onboardingKaata.currency.hint":
    "Default for all amounts in this kaata. You can change it later in settings.",
  "onboardingKaata.submit": "Create my kaata",

  // Onboarding completion (app/onboarding/success.tsx) — the game-style
  // "you made it" moment after the first kaata is created. This is where
  // the kaata concept lands: celebrate + show the shop name + one line of
  // what-next. Replaced the concept-diagram approach (Matee: teaching
  // belongs in a success message, not a mid-form card).
  "onboardingSuccess.title": "Your kaata is ready!",
  "onboardingSuccess.body":
    "This is your shop's book. Add a tally for each customer with the + button.",
  "onboardingSuccess.cta": "Open my kaata",

  // Permanent guide screen (app/guide.tsx), linked from the settings sheet.
  "guide.title": "How kaata works",
  "guide.p1": "A kaata is your shop's ledger book. One kaata holds all the accounts of one shop.",
  "guide.p2":
    "Each person you keep accounts with — customer or supplier — gets one tally inside your kaata. Add them with the + button.",
  "guide.p3":
    "On a person's tally, record I gave when you hand over money or goods, and I received when they pay you back. The balance updates by itself.",
  "guide.p4":
    "Running more than one shop? Create another kaata and switch between them by tapping the kaata name at the top of the home screen.",

  // Onboarding restore (inserted between auth and profile when the
  // backend has existing ledger state for the signed-in account).
  "onboardingRestore.title": "We found your kaata",
  // M5 multi-vault recovery: the count of non-archived vaults the account
  // belongs to. {count} is always >= 1 on this screen.
  "onboardingRestore.subtitleVaults": "Restore {count} ledger(s) saved to your account.",
  "onboardingRestore.restore.title": "Restore from cloud",
  "onboardingRestore.restore.bodyVaults":
    "Bring back all {count} of your ledgers — people, entries, and shop — on this phone.",
  "onboardingRestore.fresh.title": "Start fresh",
  "onboardingRestore.fresh.body": "Ignore the cloud copy and set up a clean ledger on this phone.",
  "onboardingRestore.fresh.confirmTitle": "Start with a clean ledger?",
  "onboardingRestore.fresh.confirmBody":
    "Your backed-up kaatas stay safe in the cloud, but they won't be restored to this phone now. You can sign in again later to restore them.",
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
  // The preferences row was folded into /vault/settings (Manage this Kaata).

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
  "preferences.diagnostics.section": "Diagnostics",
  "preferences.diagnostics.row": "App health",
  "preferences.diagnostics.rowHint": "Memory + crash info. Screenshot if asked.",

  // (Phase 5 mesh "Shop Mode" copy lives under the menu.sync.shopMode.*
  // namespace — the hamburger menu is the only surface. The earlier
  // settings.shopMode.* block was a pre-redesign draft and has been removed.)

  // Home
  "home.tab.collect": "To collect",
  "home.tab.pay": "To pay",
  "home.total.label.collect": "To collect",
  "home.total.label.pay": "To pay",
  "home.empty.collect.title": "Nothing to collect yet",
  "home.empty.collect.subtitle":
    "Tap + to add a tally for someone you keep accounts with — one per customer.",
  "home.empty.pay.title": "You owe no one yet",
  "home.empty.pay.subtitle":
    "When you take goods or borrow money, log it from that person's page and they'll appear here.",
  "home.from.someone": "from {count} person",
  "home.from.many": "from {count} people",
  "home.empty.noOneYet": "no one here yet",
  "home.empty.allSettled": "everyone settled",

  // Person detail
  "common.more": "more",
  "common.less": "less",
  "person.action.iGave": "I gave",
  "readonly.badge": "View only",
  "person.action.iReceived": "I received",
  "person.balance.theyOwe": "THEY OWE YOU",
  "person.balance.youOwe": "YOU OWE THEM",
  "person.balance.settled": "SETTLED",
  // Zero balance the shopkeeper never ruled off (or a chapter that stopped
  // adding up after a sync) — the chip slot stays labeled instead of blank.
  "person.balance.notSettled": "NOT SETTLED",
  "person.empty.title": "No entries yet",
  "person.empty.subtitle":
    'Tap "I gave" when money or goods leave your hand, "I received" when they come in.',
  // Settle-up ("rule off the account", 2026-07-27). The ruled-line row only
  // appears at balance zero with an open chapter; history collapses behind
  // one quiet row. Nothing is ever deleted.
  "person.settle.row": "Settle this account",
  "person.settle.confirm.title": "Settle up?",
  "person.settle.confirm.body":
    "Draws a line under this account with {name}. The entries stay in your book as settled history, and the next entry starts a fresh page.",
  "person.settle.confirm.cta": "Draw the line",
  "person.settle.done": "Account settled. Fresh page.",
  "person.settle.failed": "Couldn't settle. Try again.",
  "person.settle.notZero": "Balance must be zero to settle.",
  "person.history.show": "{count} settled account(s) · view all",
  "person.history.hide": "Show current account only",
  // Dated ruled-off line between chapters in the full-history view. {date}
  // is Solar Hijri with Afghan month names for fa, Gregorian for en.
  "person.history.settledOn": "Settled · {date}",
  // Closed-period guard: mutations refused inside ruled-off chapters. Fix
  // an old entry the accountant's way — a correcting entry on the open page.
  "entry.settledLocked":
    "This entry is under a settled line and can't be changed. Add a correcting entry instead.",
  "person.freshChapter.title": "All settled",
  "person.freshChapter.subtitle": "A fresh page. Your history together is kept below.",
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
  "personEdit.firstName.label": "First name",
  "personEdit.lastName.label": "Last name",
  "personEdit.phone.label": "WhatsApp number",
  "personEdit.save": "Save changes",
  "personAdd.title": "Add or find person",
  "personAdd.firstName.placeholder": "Ahmad",
  "personAdd.lastName.placeholder": "Karimi",
  "personAdd.add": "Add {name}",
  "personAdd.phone.hint": "Needed to send pings on WhatsApp.",
  "personAdd.phone.invalid": "Couldn't read that phone number. Try +93 70 123 4567.",
  "personAdd.phone.conflict": "Phone already used by {name}",
  "personAdd.phone.isSelf": "That's your own number — you can't add yourself.",
  "personAdd.section.matches": "Matches",
  "personAdd.section.recent": "Recent",
  "personAdd.section.fromPhone": "From your phone",
  "personAdd.section.allContacts": "All contacts",
  "personAdd.noMatch": 'No one matches "{query}".',
  "personAdd.empty.title": "No one here yet",
  "personAdd.empty.subtitle": "Type a name above to add your first person.",
  "personAdd.rightAmount.new": "new",
  "personAdd.rightAmount.settled": "settled",
  "personAdd.personNotFound": "Person not found.",
  "personAdd.phone.placeholderGeneric": "Phone number",
  // Inline affordance shown in place of the device-contacts list when the
  // contacts permission isn't granted (so the list isn't silently empty).
  "personAdd.contacts.allow": "Allow contacts access to add from your phone book",
  "personAdd.contacts.openSettings": "Enable contacts access in Settings",
  // Overflow row under the truncated Matches list — invites the user to
  // refine the search instead of scrolling an unbounded result set.
  "personAdd.moreResults": "+{count} more — keep typing to narrow",
  "personAdd.moreContacts": "Type a name or number to find more contacts.",

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
  "entry.deleteFailed": "Couldn't delete. Try again.",
  "entry.saveFailed": "Couldn't save. Try again.",
  // Surfaced when a local write is refused by the projection's role-gate
  // — usually because a co-owner demoted this device to viewer/editor and
  // the demotion gossiped in via mesh/sync between screen-load and save.
  "entry.roleDenied": "View only — ask the owner for editor access.",
  // Mythos Fix Set C: shown when a save can't be signed because the device
  // key cache isn't ready (EventSigningUnavailableError). Reopening the app
  // warms the cache; the retry then succeeds. Actionable, unlike the
  // generic saveFailed.
  "entry.signingUnavailable":
    "Couldn't prepare a secure save. Please reopen the app and try again.",

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
  "settings.messageLang.label": "Message language",
  "settings.messageLang.hint": "For WhatsApp messages and the shared ledger link.",
  "settings.messageLang.option.auto": "App language",
  "settings.messageLang.option.ask": "Ask every time",
  "settings.messageLang.changed": "Message language updated.",
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
  "contacts.loadFailed": "Couldn't read your contacts. Try again.",

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
  "share.footer": "— Sent via www.kaata.af",
  "share.fullLedger": "See the full ledger here:",
  "share.askLang.title": "Send in which language?",

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
  // Update prompt + banner — the force-update recovery path must be
  // readable by Persian-locale users, who are exactly who gets stuck here.
  "updatePrompt.title": "Update required",
  "updatePrompt.body":
    "Your version of Kaata is too old to continue. Install the latest update to keep using the app.",
  "updatePrompt.install": "Install v{version}",
  "updatePrompt.installGeneric": "Install update",
  "updatePrompt.openFailed": "Couldn't open the download link. Visit kaata.af/download instead.",
  "updateBanner.title": "Update available · v{version}",
  "updateBanner.cta": "Update",
  "updateBanner.learnMore": "Learn more",
  "updateBanner.dismiss": "Dismiss",
  "backupNag.title": "Back up your shop",
  "backupNag.body": "Sign in so your staff's records survive a lost phone.",
  "backupNag.cta": "Sign in to back up",
  "backupNag.dismiss": "Dismiss",

  // Foreground-service (Nearby sync) notification — sits in the shade all
  // day while Shop Mode is on; must be readable in the user's language.
  "fgs.channelName": "Nearby sync",
  "fgs.channelDescription": "Shown while Kaata keeps your ledger in sync with nearby phones.",
  "fgs.title": "Nearby sync is on",
  "fgs.waiting": "Tap to open Kaata",
  "fgs.connectedOne": "Connected to 1 phone nearby",
  "fgs.connectedMany": "Connected to {count} phones nearby",

  "home.loadFailed": "Couldn't load your Kaata data. Your entries are safe — try again.",
  "home.noKaata.title": "No kaatas yet",
  "home.noKaata.subtitle": "Set up your shop's kaata to start your ledger.",
  "home.noKaata.create": "Create a kaata",
  "home.noKaata.join": "Join an existing kaata",
  "home.noKaata.archived": "View archived kaatas ({count})",

  "common.cancel": "Cancel",
  "common.back": "Back",
  "common.refreshFailed": "Couldn't refresh — check your connection.",
  "share.whatsappUnavailable": "Couldn't open WhatsApp. Is it installed on this phone?",
  "common.retry": "Retry",
  "common.done": "Done",
  "common.loading": "Loading…",
  "common.tryAgain": "Try again",
  "common.removed": "{name} removed",
  "common.remove": "Remove",
  "common.remove.title": "Remove {name}?",
  "common.remove.description":
    "They'll disappear from your list. Their entries are kept — restore them anytime from your kaata's settings.",
  // Shared by the invite/[token] + pair/[token] deep-link screens (their
  // sign-in gates and error states use identical copy).
  "common.notNow": "Not now",
  "common.backToKaata": "Back to Kaata",
  "common.signInToContinue": "Sign in to continue",

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
  "menu.currentKaata": "Current Kaata",
  "menu.account.settings": "Account settings",
  "menu.account.settings.hint": "Name, phone, language",
  "menu.help": "Help",
  "menu.guide": "How kaata works",
  "menu.guide.hint": "Kaatas, tallies, and how they fit",
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
  "menu.sync.status.busy": "Backing up…",
  "menu.sync.status.never": "Not backed up yet — will back up when online.",
  "menu.sync.status.ok": "Backed up • {when}",
  "menu.sync.cloud": "Cloud backup",
  "menu.sync.cloud.hint":
    "Backs up this Kaata and syncs it to your other phones over the internet.",
  "menu.sync.cloud.hintOff": "Off — this Kaata only syncs to phones that are nearby.",
  "menu.sync.cloud.onToast": "Cloud backup on.",
  "menu.sync.cloud.offToast": "Cloud backup off.",
  "menu.sync.cloud.failed": "Couldn't change cloud backup.",
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
  // M5 multi-vault recovery — {count} ledgers brought back.
  "restore.toast.successVaults": "Restored {count} ledger(s) from cloud.",
  "restore.toast.sessionExpired": "Signed out. Sign in again to restore.",
  "restore.toast.timeout": "Restore timed out. Check your connection.",
  "restore.toast.generic": "Restore failed.",
  // Progress-bar status lines shown while recoverAllVaults runs (the shared
  // RestoreProgress component on the in-app, onboarding, and sign-in surfaces).
  "restoreProgress.preparing": "Preparing…",
  "restoreProgress.finding": "Finding your kaatas…",
  // Multi-vault accounts: which kaata of how many is restoring right now.
  "restoreProgress.vault": "Restoring kaata {current} of {total}…",
  // Single-vault accounts read better without the "1 of 1".
  "restoreProgress.vaultOne": "Restoring your kaata…",
  "restoreProgress.finishing": "Finishing up…",
  // Phase 6: BLE is now the PRIMARY transport. Toggle copy must match — a
  // shopkeeper reading "over WiFi" on a cellular-only phone is exactly the
  // user we built BLE for, and the old copy would make them never turn it
  // on. Keep "Nearby sync" as the noun-form key elsewhere (notification
  // channel, toasts) for stability; the visible label is the long form.
  "menu.sync.shopMode": "Sync with phones nearby",
  "menu.sync.shopMode.hint":
    "Keeps syncing over Bluetooth or Wi-Fi — even when Kaata is closed. No internet needed.",
  "menu.sync.shopMode.hintWithPeers": "{count} phones nearby",
  "menu.sync.shopMode.hintOnePeer": "1 phone nearby",
  "menu.sync.shopMode.hintLooking": "Looking for nearby phones…",
  "menu.sync.shopMode.failed": "Could not toggle Nearby sync.",
  "menu.sync.shopMode.fgsFailed":
    "Couldn't start Nearby sync — please allow notifications and try again.",
  "menu.sync.shopMode.startedToast": "Nearby sync on.",
  // #43 P2 — background-sync sub-toggle. Nested under Nearby sync (it requires
  // it). Lets a swipe-killed / closed app keep syncing to nearby phones.
  "menu.sync.bgSync": "Sync in the background",
  "menu.sync.bgSync.hint": "Keeps syncing even when Kaata is closed. Uses a little more battery.",
  "menu.sync.bgSync.hintOff": "Only syncs while Kaata is open.",
  "menu.sync.bgSync.onToast": "Background sync on.",
  "menu.sync.bgSync.offToast": "Background sync off.",
  "menu.sync.bgSync.failed": "Could not toggle background sync.",
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
  // M2c membership-chain handshake: a v1 peer tried to sync with an
  // anchored vault — they must update before they can participate.
  "menu.ble.peerOutdated": "A nearby kaata needs an update before it can sync.",
  // Battery-optimization prompt (Phase 5.1, reworded for BLE-primary).
  "menu.battery.title": "One last step: allow background",
  "menu.battery.description":
    "Nearby sync needs Android to keep Kaata's Bluetooth scan running while your phone is locked or in your pocket. Next: Settings → Battery → Unrestricted.",
  "menu.battery.confirm": "Open settings",
  "menu.battery.skip": "Skip — turn off Nearby sync",
  // OEM autostart / protected-apps (MIUI/EMUI/ColorOS…). The battery whitelist
  // alone doesn't stop these phones from killing background apps.
  "menu.oemAutostart.title": "Allow Kaata to auto-start",
  "menu.oemAutostart.description":
    "Your phone's brand can still stop Kaata in the background even with battery access. On the next screen, find Kaata and turn ON auto-start (or \"don't restrict / allow background\").",
  "menu.oemAutostart.confirm": "Open auto-start settings",
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
  "menu.account.signIn.apple": "Sign in with Apple",
  "menu.account.signIn.toast": "Signed in",
  "menu.account.signIn.partialToast":
    "Signed in, but {count} kaata(s) couldn't be restored. Pull down to retry.",
  "menu.account.signIn.failed": "Couldn't sign in — try again",
  "menu.account.signIn.signingIn": "Signing in…",
  "menu.account.signIn.restoring": "Restoring your kaatas…",
  "menu.account.signOut": "Sign out",
  "menu.account.signOut.pending": "Signing out…",
  "menu.account.signOut.toast": "Signed out",
  "menu.account.signOut.failed": "Couldn't sign out — try again",
  // Account screen (personal: name / phone / language / country / archived).
  "account.title": "Account",
  "account.profile.section": "Your details",
  "account.preferences.section": "Preferences",
  "account.kaatas.section": "Kaatas",
  "account.archived.row": "Archived kaatas",
  "account.save": "Save changes",
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
  "account.appHealth.section": "App health",
  "account.appHealth.details": "Detailed diagnostics",
  "account.appHealth.detailsHint": "Memory & crash info",
  "account.privacy.section": "Privacy & data",
  "account.privacy.label": "Privacy policy",
  "account.deleteAccount.label": "Delete account",
  "account.deleteAccount.hint": "Permanently delete your account and cloud data",
  "account.deleteAccount.confirm.title": "Delete your account?",
  "account.deleteAccount.confirm.body":
    "This permanently deletes your account and everything backed up to Kaata's servers, and removes this ledger from the phone. It cannot be undone.",
  "account.deleteAccount.confirm.cta": "Delete account",
  "account.deleteAccount.failed":
    "Couldn't delete your account. Check your connection and try again.",

  // Vault create (Phase 5.2 — Add a Kaata)
  // Copy fix: real users typed a CUSTOMER's name here (treating a "Kaata"
  // as a single person's tab), so the admin dashboard's shop_name —
  // sourced from the active vault's name — filled with tally/person names
  // instead of shops. The screen now asks plainly for the SHOP name: a
  // question title + a concrete "Shop name" field label + an example
  // placeholder. The product still calls the container a "Kaata"
  // everywhere else; only this naming step is shop-framed.
  "vaultNew.title": "What's your shop called?",
  // UX-fix #1: forced post-archive-last entry-point title. The back
  // chevron is hidden in this mode (no parent to pop to); the title
  // shifts to a directive framing so the screen reads as "you must
  // complete this".
  "vaultNew.titleForced": "Name your shop to continue",
  "vaultNew.name.label": "Shop name",
  "vaultNew.name.placeholder": "Ahmad Grocery Store",
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
  // Briar-style two-way scan — owner side (scan the joiner's code back).
  "vaultPair.twoWay.step1": "1. Let the other phone scan this code.",
  "vaultPair.twoWay.step2": "2. Then scan their code to finish.",
  "vaultPair.twoWay.scanTheirCode": "Scan their code",
  "vaultPair.twoWay.splitHint": "Show your code and scan theirs — at the same time.",
  "vaultPair.twoWay.yourCode": "Your code",
  "vaultPair.twoWay.theirCode": "Their code",
  "vaultPair.twoWay.scanning.hint": "Point at the other phone's code",
  "vaultPair.twoWay.scanAgain": "Scan again",
  "vaultPair.twoWay.wrongCode":
    "That's not the other phone's pairing code. Ask them to show their code, then scan it.",
  "vaultPair.twoWay.bound.headline": "{name} can join now",
  "vaultPair.twoWay.bound.body":
    "Their phone is syncing. You can close this once the other phone shows it joined.",
  "vaultPair.twoWay.bound.headlineNoName": "Their phone can join now",
  "vaultPair.twoWay.bound.startOver": "Wrong phone? Start over",
  // Owner must STAY on this screen until the joiner connects — leaving tears
  // down the RFCOMM listener the joiner is dialing. Wait, don't show "Done".
  "vaultPair.twoWay.bound.connecting": "Keep this screen open — {name}'s phone is connecting…",
  "vaultPair.twoWay.bound.connectingNoName": "Keep this screen open — their phone is connecting…",
  "vaultPair.twoWay.paired.headline": "Paired with {name}",
  "vaultPair.twoWay.paired.headlineNoName": "Paired",
  "vaultPair.twoWay.paired.body":
    "You're connected. Changes sync over Bluetooth when the phones are nearby.",
  "vaultPair.twoWay.camera.headline": "Allow camera",
  "vaultPair.twoWay.camera.body": "Kaata needs the camera to scan the other phone's code.",
  "vaultPair.twoWay.camera.allow": "Allow camera",
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
  "vaultPair.issueFailed": "Couldn't create the pairing code. Check your connection and try again.",
  "vaultPair.toast.paired": "A phone joined — synced over Bluetooth",
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
  // Briar-style two-way scan — joiner side (show your code back to the owner).
  "vaultPairScan.showIdentity.headline": "Show this to the shopkeeper",
  "vaultPairScan.showIdentity.body":
    "They scan this code to add you. Tap Continue after they've scanned it.",
  "vaultPairScan.showIdentity.continue": "Continue",
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
  "vaultPairScan.joined.body.syncing":
    "You're in. The first sync didn't finish — it'll catch up automatically in the background while the phones are near each other.",
  "vaultPairScan.joined.body.server":
    "Both phones will sync over the internet, and over Bluetooth when nearby. Nearby sync is on.",
  "vaultPairScan.toast.pairedNearby": "Paired — now syncing nearby",
  "vaultPairScan.toast.joinedSyncing": "Joined — syncing in the background",
  // Briar-faithful: after the joiner scans, KEEP showing its code so the owner
  // can scan it back. Not "joined" until the mutual handshake actually lands.
  "vaultPairScan.connecting.headline": "Now let them scan your code",
  "vaultPairScan.connecting.body":
    "Show this to {name}. Pairing finishes the moment they scan it on their phone.",
  "vaultPairScan.connecting.status": "Connecting…",
  "vaultPairScan.awaiting.headline": "Waiting for the other phone",
  "vaultPairScan.awaiting.body":
    "Ask {name} to scan this code on their phone — their screen has a camera too. Pairing finishes the moment they do.",
  // One-way scan: couldn't reach the host after scanning its code.
  "vaultPairScan.awaiting.hostHeadline": "Couldn't reach the other phone",
  "vaultPairScan.awaiting.hostBody":
    "Make sure the other phone is still showing its code, Bluetooth is on, and the phones are close. Then try again.",
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
  "vaultPairScan.error.scannedJoinCode":
    "That's the other phone's join code. On the phone that HAS the kaata, open it → Members → Add member, then scan that code.",
  // Joiner split-screen: tells the scanner which phone's code to point at.
  "vaultPairScan.split.hint": "Scan the code on the phone that has the kaata.",
  "vaultPairScan.split.yourCode": "Your code (so they can add you)",
  "vaultPairScan.split.theirCode": "The kaata's code",
  // D-PAIR-WITH-ROLE — confirmation screen role surfacing
  "vaultPairScan.confirm.asRole": "as {role}",
  "vaultPairScan.confirm.roleMissing": "Role not specified in this code — joining as Editor.",

  // Pair deep link (app/pair/[token].tsx) — the "Send link instead" flow.
  // Mirrors the vaultPairScan.* scanner copy but speaks about a LINK, not
  // a code, because the user got here by tapping a shared URL. Keys that
  // matched the scanner copy verbatim are reused from vaultPairScan.*
  // (signInRequired, generic, joining, headline, toast.pairedNearby,
  // confirm.join).
  "pairLink.title": "Pair phones",
  "pairLink.unsupported.title": "Scan the code in person",
  "pairLink.unsupported.body":
    "Pairing by link is no longer supported. Ask the owner to show you the pairing QR code and scan it from this phone while you're near each other.",
  "pairLink.signin.body":
    "Sign in with the SAME Google account as the other phone to complete pairing.",
  "pairLink.confirm.title": "Join {name}?",
  "pairLink.confirm.body":
    "This phone will become a second device on the kaata. Your entries will sync over the internet, and also peer-to-peer when both phones are on the same wifi.",
  // {id} is the first 8 chars of the issuer's account_id — a fingerprint
  // hint so the user can spot wrong-account links before tapping Join.
  "pairLink.confirm.fromAccount": "From account {id}…",
  "pairLink.joined.title": "Paired with\n{name}",
  "pairLink.joined.body": "Both phones will now sync when on the same wifi. Shop Mode is on.",
  "pairLink.error.missingData": "This pairing link is missing data. Ask the owner to resend it.",
  "pairLink.error.expired": "This pairing link has expired. Ask the owner to generate a new one.",
  "pairLink.error.malformed":
    "This pairing link is malformed. Make sure you opened it from the original message.",
  "pairLink.error.accountMismatch":
    "This link was issued for a different Google account. Ask the owner to send you an email invitation instead.",

  // Vault settings — Phase 7 UX critique #8 (translated).
  "vaultSettings.title": "Kaata settings",
  "vaultSettings.role.owner": "Owner",
  "vaultSettings.role.manager": "Manager",
  "vaultSettings.role.editor": "Editor",
  "vaultSettings.role.clerk": "Clerk",
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
  // Roles v2 Phase B — granting UI.
  "members.sheet.makeManager": "Make manager",
  "members.sheet.makeClerk": "Make clerk",
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
  "invite.link.intro":
    "Create a link to share this Kaata. Send it to one person — they open it, sign in, and join.",
  "invite.link.create": "Create link",
  "invite.link.createAnother": "Create another link",
  "invite.link.viewerDisclosure":
    "Viewers can see everything in this Kaata — all balances and phone numbers — but can't make changes.",
  "invite.link.editorDisclosure": "Editors can add and edit tallies in this Kaata.",
  "invite.link.clerkDisclosure":
    "Clerks can add new tallies but can never change or delete history.",
  "invite.link.ready": "Link ready",
  "invite.link.readySub": "Anyone with this link can join as {role}. Expires {when}.",
  "invite.shareWhatsapp": "Share on WhatsApp",
  "invite.tooMany": "Too many open links for this Kaata. Use or revoke some first.",
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
  "invite.role.clerk": "Clerk",
  "invite.role.clerk.hint": "Add entries only — never edit or delete",
  "invite.submit": "Create invitation",
  "invite.created": "Invitation created",
  "invite.failed": "Failed to create invitation",
  "invite.ownerOnly": "Only the Kaata owner can invite members.",
  "invite.result.sent": "Invitation sent",
  "invite.result.sub": "{email} · expires {when}",
  "invite.copy": "Copy link",
  "invite.copy.done": "Link copied",
  "invite.copy.fallback": "Link ready to share",
  "invite.copy.unavailable": "Copy unavailable",
  "invite.link.notOnServer": "This Kaata must finish syncing before you can share it.",
  "invite.share": "Share via…",
  "invite.shareMessage": "Join my Kaata: {url}",
  "invite.again": "Invite someone else",
  "invite.expiresIn.soon": "soon",
  "invite.expiresIn.lessThanDay": "in less than a day",
  "invite.expiresIn.hours": "in {hours} hours",
  "invite.expiresIn.days": "in {days} days",
  "invite.toast.noActive": "No active Kaata",
  // Blocker banners. Shown ONLY when something stops a link being created —
  // each names the blocker and nothing else. (They used to end with "use Add
  // member", the in-person QR flow that is parked with the offline mesh.)
  "invite.offline.banner": "You're offline. Creating an invite link needs internet.",
  "invite.signInRequired": "Sign in to create an invite link.",

  // Invite acceptance deep link (app/invite/[token].tsx) — the screen the
  // INVITEE lands on after tapping an emailed/shared invite URL. Role
  // labels reuse vaultPair.role.*; expiry phrasing reuses
  // invite.expiresIn.* + members.expiresLabel.
  "inviteAccept.title": "Vault invitation",
  "inviteAccept.invalidLink": "Invalid invitation link",
  "inviteAccept.signin.body":
    "You need to sign in with Google to accept this invitation. Use the email address that received the invite.",
  "inviteAccept.confirm.title": "Join {name}?",
  // Single sentence with BOTH placeholders — never split for the bold
  // {role}; the screen splits the template on "{role}" at render time so
  // Persian word order survives. {inviter} falls back to
  // inviteAccept.confirm.someone when the server sent no name/email.
  "inviteAccept.confirm.body": "{inviter} invited you to join as {role}.",
  "inviteAccept.confirm.someone": "Someone",
  "inviteAccept.confirm.accept": "Accept and join",
  "inviteAccept.confirm.decline": "Decline",
  "inviteAccept.joining": "Joining vault…",
  "inviteAccept.joinedToast": "Joined {name}",
  "inviteAccept.error.title": "Something went wrong",
  "inviteAccept.error.notVisible":
    "This invitation isn't visible on your account. The invite is anchored to a specific email — try signing in with the Google account that received the invitation.",
  "inviteAccept.error.expired": "This invitation has expired. Ask the inviter for a new one.",
  "inviteAccept.error.loadFailed": "Failed to load invitation",
  "inviteAccept.error.rateLimited": "Too many attempts. Please try again later.",
  "inviteAccept.error.acceptFailed": "Failed to accept invitation",

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

  // Export — the rows/sheets that trigger it, plus the strings rendered INTO
  // the CSV/PDF documents themselves (via tIn with an explicit locale).
  "vaultSettings.section.export": "Export",
  "vaultSettings.row.export": "Export kaata",
  "vaultSettings.row.export.hint": "PDF · CSV",
  "vaultSettings.export.sheetTitle": "Export kaata",
  "vaultSettings.toast.exportFailed": "Export failed. Try again.",
  "personEdit.export": "Export statement",
  "personEdit.exportFailed": "Export failed. Try again.",
  // Export sheet: four flat rows (format × destination). Kept flat rather
  // than a format sheet chaining into a destination sheet — stacking two
  // Modals is the Android blank-sheet trap, and it would add a tap to the
  // common (share) path.
  "export.action.sharePdf": "Share as PDF",
  "export.action.shareCsv": "Share as CSV",
  "export.action.savePdf": "Save PDF to phone",
  "export.action.saveCsv": "Save CSV to phone",
  "export.saved": "Saved {name}",
  "export.doc.statementTitle": "Statement",
  "export.doc.summaryTitle": "Kaata report",
  "export.doc.generated": "Generated {date}",
  "export.doc.peopleCount": "{n} people",
  "export.doc.entriesCount": "{n} entries",
  "export.doc.totalCollect": "Total to collect",
  "export.doc.totalPay": "Total to pay",
  "export.doc.net": "Net",
  "export.doc.balance": "Balance",
  "export.doc.empty": "No entries yet.",
  "export.col.date": "Date",
  "export.col.dateShamsi": "Date (Shamsi)",
  "export.col.person": "Name",
  "export.col.phone": "Phone",
  "export.col.note": "Note",
  "export.col.gave": "Gave",
  "export.col.received": "Received",
  "export.col.balance": "Balance",
  "export.col.entries": "Entries",
  "export.col.id": "Entry ID",

  // Removed people — the surface that makes the remove dialog's "entries
  // are kept" promise real. Section/row in vault settings (rendered only
  // when count >= 1) + the restore screen.
  "vaultSettings.section.people": "People",
  "vaultSettings.row.removedPeople": "Removed people",
  "peopleRemoved.title": "Removed people",
  "peopleRemoved.empty": "No removed people.",
  "peopleRemoved.emptySubtitle":
    "People you remove stay here with their entries, ready to restore.",
  "peopleRemoved.emptyCta": "Back",
  "peopleRemoved.removedAt": "Removed {relative}",
  "peopleRemoved.entryCount": "{n} entries",
  "peopleRemoved.entryCount.one": "1 entry",
  "peopleRemoved.restoreButton": "Restore",
  "peopleRemoved.restoredToast": "{name} is back in your book",
  "peopleRemoved.restoreFailed": "Couldn't restore. Try again.",
  "peopleRemoved.relative.justNow": "just now",
  "peopleRemoved.relative.minutesAgo": "{n}m ago",
  "peopleRemoved.relative.hoursAgo": "{n}h ago",
  "peopleRemoved.relative.daysAgo": "{n}d ago",
  "peopleRemoved.relative.monthsAgo": "{n}mo ago",
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
  "onboarding.lastName.label": "تخلص",
  "onboarding.lastName.placeholder": "احمدی",
  "onboarding.phone.label": "شماره تلفون",
  "onboarding.phone.required": "شماره تلفون لازم است",
  "onboarding.phone.hint":
    "برای اینکه کارمندان شما را در مخاطبین خود پیدا کنند. تأیید نمی‌شود و به اشتراک گذاشته نمی‌شود.",
  "onboarding.continue": "ادامه",
  "onboarding.nameRequired": "نام لازم است",
  "recovery.selfPlaceholderName": "شما",

  // Onboarding step 1 — language picker
  "onboardingLanguage.title": "زبان خود را برگزینید",
  "onboardingLanguage.subtitle": "بعداً می‌توانید این را در تنظیمات تغییر دهید.",

  // Onboarding mode picker
  "onboardingMode.title": "می‌خواهید چطور از کاتا استفاده کنید؟",
  "onboardingMode.subtitle": "بعداً می‌توانید این را در تنظیمات تغییر دهید.",
  "onboardingMode.account.label": "ذخیره در کلاد",
  "onboardingMode.account.body":
    "با ورود، یک نسخهٔ کاتای شما در کلاد می‌ماند — روی تلفون نو بازیابی کنید و از یک کاتا در چند تلفون کار بگیرید.",
  "onboardingMode.google.title": "ورود با گوگل",
  "onboardingMode.apple.title": "ورود با اپل",
  "onboardingMode.offline.label": "بدون حساب",
  "onboardingMode.offline.body": "کاتای شما فقط روی همین تلفون می‌ماند — کاملاً خصوصی.",
  "onboardingMode.offline.title": "کاملاً آفلاین",
  "onboardingMode.signInFailed": "ورود نشد. دوباره امتحان کنید.",
  "onboardingMode.expoGoHint":
    "ورود در نسخه واقعی برنامه کار می‌کند؛ فعلاً می‌توانید بدون حساب ادامه دهید.",
  "onboardingMode.back": "برگشت",

  // Onboarding profile
  "onboardingProfile.title": "خودتان را معرفی کنید",
  "onboardingProfile.subtitle":
    "نام و شماره شما — تا کسانی که با آن‌ها حساب دارید بدانند شما هستید.",
  "onboardingProfile.signedInHint": "وارد شده به نام {email}",
  "onboardingProfile.continue": "ادامه",
  "onboardingProfile.nameRequired": "لطفاً نام خود را وارد کنید",
  "onboardingProfile.shopRequired": "لطفاً برای کاتای خود نام بگذارید",
  "onboardingProfile.joinExisting": "به جای آن به کاتای موجود می‌پیوندم",

  "onboardingKaata.title": "دکان خود را راه‌اندازی کنید",
  "onboardingKaata.subtitle":
    "کاتای شما دفتر حساب دکان شماست. آن را نام بگذارید تا حساب همه را در یک جا نگه دارید.",
  "onboardingKaata.name.label": "نام دکان",
  "onboardingKaata.name.placeholder": "خوراکه فروشی احمد",
  "onboardingKaata.name.required": "نام دکان لازم است",
  "onboardingKaata.currency.label": "ارز",
  "onboardingKaata.currency.hint":
    "پیش‌فرض برای تمام مبالغ این کاتا. بعداً در تنظیمات قابل تغییر است.",
  "onboardingKaata.submit": "ساختن کاتا",

  // Onboarding completion (success screen)
  "onboardingSuccess.title": "کاتای شما آماده است!",
  "onboardingSuccess.body": "این دفتر دکان شماست. با دکمه + برای هر مشتری یک حساب اضافه کنید.",
  "onboardingSuccess.cta": "باز کردن کاتای من",

  // Permanent guide screen
  "guide.title": "کاتا چطور کار می‌کند",
  "guide.p1": "کاتا دفتر حساب دکان شماست. یک کاتا تمام حساب‌های یک دکان را نگه می‌دارد.",
  "guide.p2":
    "هر کسی که با او حساب دارید — مشتری یا تأمین‌کننده — یک حساب در داخل کاتای شما دارد. با دکمه + اضافه‌شان کنید.",
  "guide.p3":
    "در حساب هر شخص، وقتی پول یا جنس می‌دهید «دادم» و وقتی پس می‌گیرید «گرفتم» را ثبت کنید. بیلانس خودش محاسبه می‌شود.",
  "guide.p4":
    "بیش از یک دکان دارید؟ کاتای دیگری بسازید و با زدن روی نام کاتا در بالای صفحه اصلی بین آن‌ها جابه‌جا شوید.",

  // Onboarding restore
  "onboardingRestore.title": "کاتای شما پیدا شد",
  "onboardingRestore.subtitleVaults": "{count} دفتر ذخیره‌شده در حساب شما را بازیابی کنید.",
  "onboardingRestore.restore.title": "بازیابی از فضای ابری",
  "onboardingRestore.restore.bodyVaults":
    "هر {count} دفتر شما — افراد، ثبت‌ها و فروشگاه — را روی این تلفن برگردانید.",
  "onboardingRestore.fresh.title": "شروع تازه",
  "onboardingRestore.fresh.body":
    "نسخهٔ ابری را نادیده بگیرید و یک کاتای تمیز روی این تلفن بسازید.",
  "onboardingRestore.fresh.confirmTitle": "با یک دفتر تمیز شروع می‌کنید؟",
  "onboardingRestore.fresh.confirmBody":
    "کاتاهای پشتیبان‌گرفته‌شدهٔ شما در ابر امن می‌مانند، اما اکنون روی این تلفن بازگردانی نمی‌شوند. می‌توانید بعداً دوباره وارد شوید تا آن‌ها را بازگردانی کنید.",
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
  // killed the /account screen and its dependent strings; the preferences row
  // was folded into /vault/settings).

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
  "preferences.diagnostics.section": "عیب‌یابی",
  "preferences.diagnostics.row": "وضعیت برنامه",
  "preferences.diagnostics.rowHint": "اطلاعات حافظه و خرابی. در صورت درخواست اسکرین‌شات بگیرید.",

  // Home
  "home.tab.collect": "وصول",
  "home.tab.pay": "پرداخت",
  "home.total.label.collect": "قابل وصول",
  "home.total.label.pay": "قابل پرداخت",
  "home.empty.collect.title": "هنوز چیزی برای وصول نیست",
  "home.empty.collect.subtitle":
    "با دکمه + برای کسی که با او حساب دارید یک حساب بسازید — برای هر مشتری یکی.",
  "home.empty.pay.title": "هنوز از کسی قرضدار نیستید",
  "home.empty.pay.subtitle":
    "وقتی جنس می‌گیرید یا پول قرض می‌کنید، از صفحه آن شخص ثبت کنید — همین‌جا ظاهر می‌شود.",
  "home.from.someone": "از یک نفر",
  "home.from.many": "از {count} نفر",
  "home.empty.noOneYet": "هنوز کسی نیست",
  "home.empty.allSettled": "همه تصفیه شده",

  // Person detail
  "common.more": "بیشتر",
  "common.less": "کمتر",
  "person.action.iGave": "دادم",
  "readonly.badge": "فقط دیدن",
  "person.action.iReceived": "گرفتم",
  "person.balance.theyOwe": "از شما قرضدار",
  "person.balance.youOwe": "از او قرضدار",
  "person.balance.settled": "تصفیه شده",
  "person.balance.notSettled": "تصفیه نشده",
  "person.empty.title": "هنوز ثبتی نیست",
  "person.empty.subtitle":
    'وقتی پول یا جنس از دست‌تان می‌رود "دادم" را بزنید، وقتی به دست‌تان می‌آید "گرفتم".',
  "person.settle.row": "تصفیهٔ این حساب",
  "person.settle.confirm.title": "حساب تصفیه شود؟",
  "person.settle.confirm.body":
    "زیر این حساب با {name} خط کشیده می‌شود. ثبت‌ها به عنوان سابقهٔ تصفیه‌شده در کتاب شما می‌مانند و ثبت بعدی صفحهٔ تازه‌ای را شروع می‌کند.",
  "person.settle.confirm.cta": "خط بکش",
  "person.settle.done": "حساب تصفیه شد. صفحهٔ تازه.",
  "person.settle.failed": "تصفیه نشد. دوباره تلاش کنید.",
  "person.settle.notZero": "برای تصفیه، باقی‌مانده باید صفر باشد.",
  "person.history.show": "{count} حساب تصفیه‌شده · دیدن همه",
  "person.history.hide": "فقط حساب جاری",
  "person.history.settledOn": "تصفیه شد · {date}",
  "entry.settledLocked":
    "این ثبت زیر خط تصفیه است و قابل تغییر نیست. به جای آن یک ثبت اصلاحی اضافه کنید.",
  "person.freshChapter.title": "همه تصفیه شد",
  "person.freshChapter.subtitle": "صفحهٔ تازه. سابقهٔ شما با هم در پایین نگه داشته شده است.",
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
  "personEdit.firstName.label": "نام",
  "personEdit.lastName.label": "تخلص",
  "personEdit.phone.label": "شماره واتساپ",
  "personEdit.save": "ذخیره تغییرات",
  "personAdd.title": "افزودن یا یافتن شخص",
  "personAdd.firstName.placeholder": "احمد",
  "personAdd.lastName.placeholder": "کریمی",
  "personAdd.add": "افزودن {name}",
  "personAdd.phone.hint": "برای ارسال یادآوری در واتساپ لازم است.",
  "personAdd.phone.invalid": "این شماره را نتوانستم بخوانم. مثلاً +93 70 123 4567.",
  "personAdd.phone.conflict": "این شماره قبلاً برای {name} ثبت شده",
  "personAdd.phone.isSelf": "این شماره خود شماست — نمی‌توانید خودتان را اضافه کنید.",
  "personAdd.section.matches": "نتایج",
  "personAdd.section.recent": "اخیر",
  "personAdd.section.fromPhone": "از مخاطبین تلفن",
  "personAdd.section.allContacts": "همه مخاطبین",
  "personAdd.noMatch": "هیچ‌کس با «{query}» مطابقت نمی‌کند.",
  "personAdd.empty.title": "هنوز کسی نیست",
  "personAdd.empty.subtitle": "نام را در بالا تایپ کنید تا اولین شخص را اضافه کنید.",
  "personAdd.rightAmount.new": "جدید",
  "personAdd.rightAmount.settled": "تصفیه",
  "personAdd.personNotFound": "این شخص پیدا نشد.",
  "personAdd.phone.placeholderGeneric": "شماره تلفون",
  // Inline affordance when contacts permission isn't granted.
  "personAdd.contacts.allow": "برای افزودن از دفترچه تلفن، اجازهٔ دسترسی به مخاطبین را بدهید",
  "personAdd.contacts.openSettings": "دسترسی به مخاطبین را در تنظیمات فعال کنید",
  // Overflow row under the truncated Matches list.
  "personAdd.moreResults": "{count}+ نتیجهٔ دیگر — برای محدود کردن، بیشتر تایپ کنید",
  "personAdd.moreContacts": "برای یافتن مخاطبین بیشتر، نام یا شماره را تایپ کنید.",

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
  "entry.deleteFailed": "حذف نشد. دوباره امتحان کنید.",
  "entry.saveFailed": "ذخیره نشد. دوباره امتحان کنید.",
  "entry.roleDenied": "فقط مشاهده — از مالک اجازه ویرایشگر بخواهید.",
  "entry.signingUnavailable": "ذخیره امن آماده نشد. لطفاً برنامه را دوباره باز کنید و امتحان کنید.",
  "projectionConflicts.toast.roleGate": "نقش شما تغییر کرد — آن تغییر ذخیره نشد.",
  "projectionConflicts.toast.serverRejected":
    "سرور آخرین تغییر شما را نپذیرفت. لطفاً تازه‌سازی کنید.",

  // Update prompt + banner
  "updatePrompt.title": "به‌روزرسانی لازم است",
  "updatePrompt.body":
    "نسخهٔ کاتای شما برای ادامه خیلی قدیمی است. برای استفاده از برنامه، آخرین به‌روزرسانی را نصب کنید.",
  "updatePrompt.install": "نصب نسخه {version}",
  "updatePrompt.installGeneric": "نصب به‌روزرسانی",
  "updatePrompt.openFailed": "لینک دانلود باز نشد. به kaata.af/download مراجعه کنید.",
  "updateBanner.title": "به‌روزرسانی موجود است · نسخه {version}",
  "updateBanner.cta": "به‌روزرسانی",
  "updateBanner.learnMore": "بیشتر بدانید",
  "updateBanner.dismiss": "بستن",
  "backupNag.title": "از دکان خود پشتیبان بگیرید",
  "backupNag.body": "وارد شوید تا سوابق کارمندان‌تان با گم‌شدن گوشی از بین نرود.",
  "backupNag.cta": "برای پشتیبان‌گیری وارد شوید",
  "backupNag.dismiss": "بستن",

  // Foreground-service (Nearby sync) notification
  "fgs.channelName": "همگام‌سازی نزدیک",
  "fgs.channelDescription": "هنگام همگام‌سازی دفتر شما با تلفون‌های نزدیک نشان داده می‌شود.",
  "fgs.title": "همگام‌سازی نزدیک روشن است",
  "fgs.waiting": "برای باز کردن کاتا ضربه بزنید",
  "fgs.connectedOne": "به ۱ تلفون نزدیک وصل است",
  "fgs.connectedMany": "به {count} تلفون نزدیک وصل است",

  "home.loadFailed": "داده‌های کاتای شما بارگیری نشد. ثبت‌های شما محفوظ است — دوباره امتحان کنید.",
  "home.noKaata.title": "هنوز کاتایی نیست",
  "home.noKaata.subtitle": "کاتای دکان خود را بسازید تا دفتر حساب‌تان شروع شود.",
  "home.noKaata.create": "ساختن کاتا",
  "home.noKaata.join": "پیوستن به یک کاتای موجود",
  "home.noKaata.archived": "کاتاهای بایگانی‌شده ({count})",

  // Settings — only "settings.saved" remains (person/edit auto-save toast).
  "settings.saved": "ذخیره شد",
  "settings.language.label": "زبان",
  "settings.language.option.system": "پیش‌فرض سیستم",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "زبان تغییر کرد.",
  "settings.messageLang.label": "زبان پیام",
  "settings.messageLang.hint": "برای پیام‌های واتساپ و لینک کاتا.",
  "settings.messageLang.option.auto": "زبان برنامه",
  "settings.messageLang.option.ask": "هر بار پرسیده شود",
  "settings.messageLang.changed": "زبان پیام تغییر کرد.",
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
  "contacts.loadFailed": "مخاطبین شما خوانده نشد. دوباره امتحان کنید.",

  // WhatsApp share — full message body sent to the customer.
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "کاتای شما با {accountWith}:",
  "share.theyOwe.amount": "🔴 قرض شما: −{amount} {currency}",
  "share.theyOwe.cta": "لطفاً وقتی توانستید تصفیه کنید.",
  "share.youOwe.header": "کاتای ما:",
  "share.youOwe.amount": "🟢 قرضدار تان هستم: +{amount} {currency}",
  "share.youOwe.cta": "به‌زودی تصفیه می‌کنم.",
  "share.settled.line": "🤝 کاتای ما کاملاً تصفیه شده.",
  "share.settled.cta": "تشکر.",
  "share.footer": "پیام از طرف www.kaata.af",
  "share.fullLedger": "کاتای مکمل را اینجا ببینید:",
  "share.askLang.title": "پیام به کدام زبان فرستاده شود؟",

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
  "common.refreshFailed": "تازه‌سازی نشد — اتصال خود را بررسی کنید.",
  "share.whatsappUnavailable": "واتساپ باز نشد. آیا روی این تلفون نصب است؟",
  "common.retry": "تلاش دوباره",
  "common.removed": "{name} حذف شد",
  "common.remove": "حذف",
  "common.remove.title": "{name} حذف شود؟",
  "common.remove.description":
    "از لیست شما حذف می‌شود. ثبت‌های آن‌ها نگه داشته می‌شود — هر وقت خواستید از تنظیمات کاتا بازگردانید.",
  // Shared by the invite/[token] + pair/[token] deep-link screens.
  "common.notNow": "حالا نه",
  "common.backToKaata": "بازگشت به کاتا",
  "common.signInToContinue": "برای ادامه وارد شوید",

  // Profile sheet (Phase 7) — Persian counterparts. Section labels in
  // normal case; the SectionHeader atom applies textTransform:"uppercase"
  // at render time. Persian has no case so the transform is a no-op
  // for this locale.
  "menu.title.profile": "پروفایل و تنظیمات",
  "menu.title.vaultSwitcher": "تعویض کاتا",
  "menu.thisKaata.settings": "مدیریت این کاتا",
  "menu.currentKaata": "کاتای فعلی",
  "menu.account.settings": "تنظیمات حساب",
  "menu.account.settings.hint": "نام، شماره، زبان",
  "menu.help": "راهنما",
  "menu.guide": "کاتا چطور کار می‌کند",
  "menu.guide.hint": "کاتا، حساب‌ها و طرز کارشان",
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
  "menu.sync.status.busy": "در حال پشتیبان‌گیری…",
  "menu.sync.status.never": "هنوز پشتیبان‌گیری نشده — هنگام اتصال انجام می‌شود.",
  "menu.sync.status.ok": "پشتیبان‌گیری شد • {when}",
  "menu.sync.cloud": "پشتیبان‌گیری ابری",
  "menu.sync.cloud.hint":
    "این کاتا را پشتیبان می‌گیرد و از طریق اینترنت با تلفون‌های دیگرتان همگام می‌کند.",
  "menu.sync.cloud.hintOff": "خاموش — این کاتا تنها با تلفون‌های نزدیک همگام می‌شود.",
  "menu.sync.cloud.onToast": "پشتیبان‌گیری ابری روشن شد.",
  "menu.sync.cloud.offToast": "پشتیبان‌گیری ابری خاموش شد.",
  "menu.sync.cloud.failed": "تغییر پشتیبان‌گیری ابری ناکام شد.",
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
  "restore.toast.successVaults": "{count} دفتر از کلاد بازیابی شد.",
  "restore.toast.sessionExpired": "خارج شدید. برای بازیابی دوباره وارد شوید.",
  "restore.toast.timeout": "بازیابی به وقفه خورد. اتصال خود را بررسی کنید.",
  "restore.toast.generic": "بازیابی ناکام شد.",
  // Progress-bar status lines (RestoreProgress).
  "restoreProgress.preparing": "در حال آماده‌سازی…",
  "restoreProgress.finding": "در حال یافتن کاتاهای شما…",
  "restoreProgress.vault": "در حال بازیابی کاتای {current} از {total}…",
  "restoreProgress.vaultOne": "در حال بازیابی کاتای شما…",
  "restoreProgress.finishing": "در حال نهایی‌سازی…",
  // Phase 6: BLE-primary copy. Persian uses "بلوتوث" (Bluetooth) — it's a
  // loanword every Afghan shopkeeper recognizes; "اینترنت/وای‌فای نیاز ندارد"
  // makes the no-connectivity benefit explicit.
  "menu.sync.shopMode": "همگام‌سازی با تلفون‌های نزدیک",
  "menu.sync.shopMode.hint":
    "حتی وقتی کاتا بسته است از طریق بلوتوث یا وای‌فای همگام‌سازی می‌کند — به اینترنت نیاز ندارد.",
  "menu.sync.shopMode.hintWithPeers": "{count} تلفون نزدیک",
  "menu.sync.shopMode.hintOnePeer": "۱ تلفون نزدیک",
  "menu.sync.shopMode.hintLooking": "در حال یافتن تلفون‌های نزدیک…",
  "menu.sync.shopMode.startedToast": "همگام‌سازی نزدیک روشن.",
  "menu.sync.shopMode.failed": "تغییر همگام‌سازی نزدیک ناکام شد.",
  "menu.sync.shopMode.fgsFailed":
    "همگام‌سازی نزدیک شروع نشد — لطفاً اجازه اعلان‌ها را بدهید و دوباره امتحان کنید.",
  "menu.sync.bgSync": "همگام‌سازی در پس‌زمینه",
  "menu.sync.bgSync.hint":
    "حتی وقتی کاتا بسته است همگام‌سازی ادامه می‌یابد. کمی بیشتر باتری مصرف می‌کند.",
  "menu.sync.bgSync.hintOff": "فقط زمانی که کاتا باز است همگام‌سازی می‌شود.",
  "menu.sync.bgSync.onToast": "همگام‌سازی پس‌زمینه روشن.",
  "menu.sync.bgSync.offToast": "همگام‌سازی پس‌زمینه خاموش.",
  "menu.sync.bgSync.failed": "تغییر همگام‌سازی پس‌زمینه ناکام شد.",
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
  "menu.ble.peerOutdated":
    "کاتای یک تلفون نزدیک به به‌روزرسانی نیاز دارد تا بتواند همگام‌سازی کند.",
  // Battery-optimization prompt
  "menu.battery.title": "یک قدم آخر: اجازهٔ پس‌زمینه",
  "menu.battery.description":
    "همگام‌سازی نزدیک نیاز دارد که اندروید اجازه دهد بلوتوث کاتا حتی وقت قفل بودن تلفون فعال بماند. بعد: تنظیمات ← باتری ← بدون محدودیت.",
  "menu.battery.confirm": "باز کردن تنظیمات",
  "menu.battery.skip": "رد کردن — همگام‌سازی نزدیک خاموش",
  "menu.oemAutostart.title": "اجازهٔ خودکار-اجرا به کاتا",
  "menu.oemAutostart.description":
    "برند تلفون شما می‌تواند حتی با دسترسی باتری هم کاتا را در پس‌زمینه متوقف کند. در صفحهٔ بعد، کاتا را پیدا کنید و «خودکار-اجرا» را روشن کنید (یا «بدون محدودیت / اجازهٔ پس‌زمینه»).",
  "menu.oemAutostart.confirm": "باز کردن تنظیمات خودکار-اجرا",
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
  "menu.account.signIn.apple": "ورود با اپل",
  "menu.account.signIn.toast": "ورود انجام شد",
  "menu.account.signIn.partialToast":
    "وارد شدید، اما {count} کاتا بازیابی نشد. برای تلاش دوباره به پایین بکشید.",
  "menu.account.signIn.failed": "ورود ناموفق — دوباره کوشش کنید",
  "menu.account.signIn.signingIn": "در حال ورود…",
  "menu.account.signIn.restoring": "در حال بازیابی کاتاها…",
  "menu.account.signOut": "خروج",
  "menu.account.signOut.pending": "در حال خروج…",
  "menu.account.signOut.toast": "خروج انجام شد",
  "menu.account.signOut.failed": "خروج ناموفق — دوباره کوشش کنید",
  // Account screen.
  "account.title": "حساب",
  "account.profile.section": "مشخصات شما",
  "account.preferences.section": "ترجیحات",
  "account.kaatas.section": "کاتاها",
  "account.archived.row": "کاتاهای بایگانی‌شده",
  "account.save": "ذخیره تغییرات",
  "menu.account.signOut.confirm.title": "خارج می‌شوید؟",
  "menu.account.signOut.confirm.body":
    "از حساب {email} خارج می‌شوید. کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.bodyGeneric":
    "کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.cta": "خروج",
  "menu.account.switch": "تعویض حساب گوگل",
  "menu.account.localOnlyHint": "برای پشتیبان‌گیری و همگام‌سازی بین تلفون‌ها وارد شوید.",
  "menu.about": "درباره",
  "account.appHealth.section": "وضعیت برنامه",
  "account.appHealth.details": "عیب‌یابی مفصل",
  "account.appHealth.detailsHint": "اطلاعات حافظه و خرابی",
  "account.privacy.section": "حریم خصوصی و داده‌ها",
  "account.privacy.label": "سیاست حریم خصوصی",
  "account.deleteAccount.label": "حذف حساب",
  "account.deleteAccount.hint": "حساب و داده‌های ابری شما برای همیشه حذف می‌شود",
  "account.deleteAccount.confirm.title": "حساب‌تان حذف شود؟",
  "account.deleteAccount.confirm.body":
    "این کار حساب شما و همه چیزی را که در سرورهای کاتا پشتیبان‌گیری شده برای همیشه حذف می‌کند و این کاتا را از تلفن پاک می‌کند. قابل بازگشت نیست.",
  "account.deleteAccount.confirm.cta": "حذف حساب",
  "account.deleteAccount.failed":
    "حذف حساب ناموفق بود. اتصال‌تان را بررسی کنید و دوباره تلاش کنید.",

  // Vault create (Phase 5.2). Shop-framed to stop users naming the kaata
  // after a customer — see the English block's note.
  "vaultNew.title": "نام دکان شما چیست؟",
  "vaultNew.titleForced": "برای ادامه، نام دکان را بنویسید",
  "vaultNew.name.label": "نام دکان",
  "vaultNew.name.placeholder": "خوراکه فروشی احمد",
  "vaultNew.name.required": "نام لازم است",
  "vaultNew.currency.label": "ارز",
  "vaultNew.currency.hint": "پیش‌فرض برای تمام مبالغ این کاتا. بعداً در تنظیمات قابل تغییر است.",
  "vaultNew.localOnlyHint": "وارد نشده‌اید. این کاتا فقط روی همین تلفون می‌ماند تا وقتی وارد شوید.",
  "vaultNew.submit": "ایجاد کاتا",
  "vaultNew.created": "{name} ایجاد شد",
  "vaultNew.failed": "ایجاد کاتا ناکام شد",

  // Vault pair (owner side)
  "vaultPair.title": "افزودن تلفون به این کاتا",
  "vaultPair.twoWay.step1": "۱. بگذارید تلفون دیگر این کود را اسکن کند.",
  "vaultPair.twoWay.step2": "۲. سپس کود آن‌ها را اسکن کنید تا تمام شود.",
  "vaultPair.twoWay.scanTheirCode": "کود آن‌ها را اسکن کنید",
  "vaultPair.twoWay.splitHint": "کود خود را نشان دهید و کود آن‌ها را اسکن کنید — هم‌زمان.",
  "vaultPair.twoWay.yourCode": "کود شما",
  "vaultPair.twoWay.theirCode": "کود آن‌ها",
  "vaultPair.twoWay.scanning.hint": "کمره را روی کود تلفون دیگر بگیرید",
  "vaultPair.twoWay.scanAgain": "دوباره اسکن کنید",
  "vaultPair.twoWay.wrongCode":
    "این کود جفت‌سازی تلفون دیگر نیست. از آن‌ها بخواهید کودشان را نشان دهند، سپس اسکن کنید.",
  "vaultPair.twoWay.bound.headline": "{name} اکنون می‌تواند بپیوندد",
  "vaultPair.twoWay.bound.body":
    "تلفون آن‌ها در حال همگام‌سازی است. وقتی تلفون دیگر «پیوست» را نشان داد می‌توانید این را ببندید.",
  "vaultPair.twoWay.bound.headlineNoName": "تلفون آن‌ها اکنون می‌تواند بپیوندد",
  "vaultPair.twoWay.bound.startOver": "تلفون اشتباه؟ از نو شروع کنید",
  "vaultPair.twoWay.bound.connecting": "این صفحه را باز نگه دارید — تلفون {name} در حال اتصال است…",
  "vaultPair.twoWay.bound.connectingNoName":
    "این صفحه را باز نگه دارید — تلفون آن‌ها در حال اتصال است…",
  "vaultPair.twoWay.paired.headline": "جفت شد با {name}",
  "vaultPair.twoWay.paired.headlineNoName": "جفت شد",
  "vaultPair.twoWay.paired.body":
    "متصل شدید. وقتی تلفون‌ها نزدیک باشند، تغییرات از طریق بلوتوث همگام می‌شوند.",
  "vaultPair.twoWay.camera.headline": "اجازه کمره",
  "vaultPair.twoWay.camera.body": "کاتا برای اسکن کود تلفون دیگر به کمره نیاز دارد.",
  "vaultPair.twoWay.camera.allow": "اجازه کمره",
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
  "vaultPair.issueFailed": "کود جفت‌سازی ساخته نشد. اتصال خود را بررسی کنید و دوباره امتحان کنید.",
  "vaultPair.toast.paired": "یک گوشی وصل شد — از طریق بلوتوث همگام شد",
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
  "vaultPairScan.showIdentity.headline": "این را به دکاندار نشان دهید",
  "vaultPairScan.showIdentity.body":
    "آن‌ها این کود را اسکن می‌کنند تا شما را اضافه کنند. پس از اسکن، روی ادامه بزنید.",
  "vaultPairScan.showIdentity.continue": "ادامه",
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
  "vaultPairScan.joined.body.syncing":
    "عضو شدید. اولین همگام‌سازی کامل نشد — وقتی تلفون‌ها نزدیک هم باشند، در پس‌زمینه به‌طور خودکار همگام می‌شود.",
  "vaultPairScan.joined.body.server":
    "دو تلفون با انترنت و نیز با بلوتوث در صورت نزدیکی همگام می‌شوند. همگام‌سازی نزدیک روشن شد.",
  "vaultPairScan.toast.pairedNearby": "جفت شد — در حال همگام‌سازی نزدیک",
  "vaultPairScan.toast.joinedSyncing": "عضو شدید — در حال همگام‌سازی در پس‌زمینه",
  "vaultPairScan.connecting.headline": "حالا بگذارید کود شما را اسکن کنند",
  "vaultPairScan.connecting.body":
    "این را به {name} نشان دهید. به‌محض اینکه آن را در تلفون خود اسکن کنند، جفت‌سازی تمام می‌شود.",
  "vaultPairScan.connecting.status": "در حال اتصال…",
  "vaultPairScan.awaiting.headline": "در انتظار تلفون دیگر",
  "vaultPairScan.awaiting.body":
    "از {name} بخواهید این کود را در تلفون خود اسکن کند — صفحه آن‌ها هم کمره دارد. به‌محض اینکه اسکن کنند، جفت‌سازی تمام می‌شود.",
  "vaultPairScan.awaiting.hostHeadline": "رسیدن به تلفون دیگر ناکام شد",
  "vaultPairScan.awaiting.hostBody":
    "مطمئن شوید تلفون دیگر هنوز کود خود را نشان می‌دهد، بلوتوث روشن است و تلفون‌ها نزدیک هستند. سپس دوباره کوشش کنید.",
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
  "vaultPairScan.error.scannedJoinCode":
    "این کود پیوستن تلفون دیگر است. در تلفونی که کاتا را دارد، آن را باز کنید ← اعضا ← افزودن عضو، سپس آن کود را اسکن کنید.",
  // Joiner split-screen: tells the scanner which phone's code to point at.
  "vaultPairScan.split.hint": "کود تلفونی را که کاتا را دارد اسکن کنید.",
  "vaultPairScan.split.yourCode": "کود شما (تا شما را اضافه کنند)",
  "vaultPairScan.split.theirCode": "کود کاتا",
  // D-PAIR-WITH-ROLE — confirmation role surfacing (Persian)
  "vaultPairScan.confirm.asRole": "به عنوان {role}",
  "vaultPairScan.confirm.roleMissing": "نقش در این کود مشخص نشده — به عنوان ویرایشگر می‌پیوندید.",

  // Pair deep link (app/pair/[token].tsx) — Persian. Speaks about a LINK
  // (لینک) not a code (کود) because the user arrived by tapping a shared
  // URL. NOTE: the English "Shop Mode is on" is rendered in Persian as
  // «همگام‌سازی نزدیک روشن شد» — the fa table consistently calls this
  // feature "Nearby sync" (Phase 6 rename) and "Shop Mode" never appears
  // in Persian copy.
  "pairLink.title": "جفت‌سازی تلفون‌ها",
  "pairLink.unsupported.title": "کد را حضوری اسکن کنید",
  "pairLink.unsupported.body":
    "جفت‌سازی از طریق لینک دیگر پشتیبانی نمی‌شود. از مالک بخواهید کد QR جفت‌سازی را نشان دهد و وقتی نزدیک هم هستید آن را از این تلفون اسکن کنید.",
  "pairLink.signin.body": "برای تکمیل جفت‌سازی، با همان حساب گوگل تلفون دیگر وارد شوید.",
  "pairLink.confirm.title": "به {name} بپیوندید؟",
  "pairLink.confirm.body":
    "این تلفون به عنوان تلفون دوم این کاتا اضافه می‌شود. ورودی‌ها از طریق انترنت همگام می‌شوند و وقتی هر دو تلفون روی یک وای‌فای باشند، مستقیم هم.",
  "pairLink.confirm.fromAccount": "از حساب {id}…",
  "pairLink.joined.title": "جفت شد با\n{name}",
  "pairLink.joined.body":
    "هر دو تلفون از این پس وقتی روی یک وای‌فای باشند همگام می‌شوند. همگام‌سازی نزدیک روشن شد.",
  "pairLink.error.missingData": "این لینک جفت‌سازی ناقص است. از مالک بخواهید دوباره بفرستد.",
  "pairLink.error.expired": "این لینک جفت‌سازی منقضی شده. از مالک بخواهید لینک جدید بسازد.",
  "pairLink.error.malformed":
    "این لینک جفت‌سازی خراب است. مطمئن شوید آن را از پیام اصلی باز کرده‌اید.",
  "pairLink.error.accountMismatch":
    "این لینک برای حساب گوگل دیگری ساخته شده. از مالک بخواهید دعوت ایمیلی بفرستد.",

  "common.done": "تمام",
  "common.loading": "بارگیری…",
  "common.tryAgain": "دوباره کوشش",

  // Vault settings — Persian
  "vaultSettings.title": "تنظیمات کاتا",
  "vaultSettings.role.owner": "مالک",
  "vaultSettings.role.manager": "مدیر",
  "vaultSettings.role.editor": "ویرایشگر",
  "vaultSettings.role.clerk": "ثبت‌کننده",
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
  "members.sheet.makeManager": "مدیر کردن",
  "members.sheet.makeClerk": "ثبت‌کننده کردن",
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
  "invite.link.intro":
    "یک لینک برای اشتراک این کاتا بسازید. آن را به یک نفر بفرستید — او لینک را باز می‌کند، وارد می‌شود و می‌پیوندد.",
  "invite.link.create": "ساختن لینک",
  "invite.link.createAnother": "ساختن لینک دیگر",
  "invite.link.viewerDisclosure":
    "بیننده‌ها همه‌چیز این کاتا را می‌بینند — همه مانده‌ها و شماره‌ها — اما نمی‌توانند تغییری بدهند.",
  "invite.link.editorDisclosure": "ویرایشگرها می‌توانند در این کاتا ثبت اضافه و ویرایش کنند.",
  "invite.link.clerkDisclosure":
    "ثبت‌کننده‌ها می‌توانند ثبت تازه اضافه کنند اما هرگز نمی‌توانند سابقه را تغییر دهند یا حذف کنند.",
  "invite.link.ready": "لینک آماده شد",
  "invite.link.readySub":
    "هر کسی این لینک را داشته باشد می‌تواند به‌عنوان {role} بپیوندد. انقضا {when}.",
  "invite.shareWhatsapp": "اشتراک در واتساپ",
  "invite.tooMany": "لینک‌های باز این کاتا زیاد است. اول چند تا را استفاده یا لغو کنید.",
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
  "invite.role.clerk": "ثبت‌کننده",
  "invite.role.clerk.hint": "فقط افزودن ثبت — بدون ویرایش و حذف",
  "invite.role.viewer": "بیننده",
  "invite.role.viewer.hint": "دسترسی فقط‌خواندنی",
  "invite.submit": "ایجاد دعوت",
  "invite.created": "دعوت ایجاد شد",
  "invite.failed": "ایجاد دعوت ناکام شد",
  "invite.ownerOnly": "فقط مالک کاتا می‌تواند عضو دعوت کند.",
  "invite.result.sent": "دعوت ارسال شد",
  "invite.result.sub": "{email} · انقضا {when}",
  "invite.copy": "کپی لینک",
  "invite.copy.done": "لینک کپی شد",
  "invite.copy.fallback": "لینک آماده اشتراک",
  "invite.copy.unavailable": "کپی ممکن نیست",
  "invite.link.notOnServer": "این کاتا باید همگام‌سازی شود تا بتوانید آن را به اشتراک بگذارید.",
  "invite.share": "اشتراک از طریق…",
  "invite.shareMessage": "به کاتای من بپیوندید: {url}",
  "invite.again": "دعوت شخص دیگری",
  "invite.expiresIn.soon": "به زودی",
  "invite.expiresIn.lessThanDay": "در کمتر از یک روز",
  "invite.expiresIn.hours": "در {hours} ساعت",
  "invite.expiresIn.days": "در {days} روز",
  "invite.toast.noActive": "کاتای فعال نیست",
  // Blocker banners (see the en table).
  "invite.offline.banner": "آفلاین هستید. ساختن لینک دعوت به انترنت نیاز دارد.",
  "invite.signInRequired": "برای ساختن لینک دعوت، وارد شوید.",

  // Invite acceptance deep link (app/invite/[token].tsx) — Persian. Role
  // labels reuse vaultPair.role.*; expiry phrasing reuses invite.expiresIn.*
  // + members.expiresLabel.
  "inviteAccept.title": "دعوت به کاتا",
  "inviteAccept.invalidLink": "لینک دعوت معتبر نیست",
  "inviteAccept.signin.body":
    "برای پذیرفتن این دعوت باید با گوگل وارد شوید. از همان ایمیلی وارد شوید که دعوت به آن رسیده است.",
  "inviteAccept.confirm.title": "به {name} بپیوندید؟",
  "inviteAccept.confirm.body": "{inviter} شما را دعوت کرده است تا به عنوان {role} بپیوندید.",
  "inviteAccept.confirm.someone": "کسی",
  "inviteAccept.confirm.accept": "پذیرفتن و پیوستن",
  "inviteAccept.confirm.decline": "رد کردن",
  "inviteAccept.joining": "در حال پیوستن به کاتا…",
  "inviteAccept.joinedToast": "به {name} پیوستید",
  "inviteAccept.error.title": "مشکلی پیش آمد",
  "inviteAccept.error.notVisible":
    "این دعوت در حساب شما دیده نمی‌شود. دعوت به یک ایمیل مشخص گره خورده است — با همان حساب گوگلی وارد شوید که دعوت را دریافت کرده است.",
  "inviteAccept.error.expired": "این دعوت منقضی شده است. از دعوت‌کننده بخواهید دعوت جدید بفرستد.",
  "inviteAccept.error.loadFailed": "بار کردن دعوت ناکام شد",
  "inviteAccept.error.rateLimited": "تلاش‌های زیاد. کمی بعد دوباره امتحان کنید.",
  "inviteAccept.error.acceptFailed": "پذیرفتن دعوت ناکام شد",

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

  // Export
  "vaultSettings.section.export": "گزارش",
  "vaultSettings.row.export": "گزارش کاتا",
  "vaultSettings.row.export.hint": "PDF · CSV",
  "vaultSettings.export.sheetTitle": "گزارش کاتا",
  "vaultSettings.toast.exportFailed": "گزارش ساخته نشد. دوباره تلاش کنید.",
  "personEdit.export": "صورت حساب",
  "personEdit.exportFailed": "صورت حساب ساخته نشد. دوباره تلاش کنید.",
  "export.action.sharePdf": "ارسال به شکل PDF",
  "export.action.shareCsv": "ارسال به شکل CSV",
  "export.action.savePdf": "ذخیرهٔ PDF در تلفون",
  "export.action.saveCsv": "ذخیرهٔ CSV در تلفون",
  "export.saved": "{name} ذخیره شد",
  "export.doc.statementTitle": "صورت حساب",
  "export.doc.summaryTitle": "گزارش کاتا",
  "export.doc.generated": "تهیه شده در {date}",
  "export.doc.peopleCount": "{n} نفر",
  "export.doc.entriesCount": "{n} ثبت",
  "export.doc.totalCollect": "جمع وصول",
  "export.doc.totalPay": "جمع پرداخت",
  "export.doc.net": "خالص",
  "export.doc.balance": "باقی‌مانده",
  "export.doc.empty": "هنوز ثبتی نیست.",
  "export.col.date": "تاریخ",
  "export.col.dateShamsi": "تاریخ شمسی",
  "export.col.person": "نام",
  "export.col.phone": "تلفون",
  "export.col.note": "یادداشت",
  "export.col.gave": "دادم",
  "export.col.received": "گرفتم",
  "export.col.balance": "باقی‌مانده",
  "export.col.entries": "ثبت‌ها",
  // نمبر not شناسه — the table's Afghan-vernacular rule (شناسه is Iranian register).
  "export.col.id": "نمبر ثبت",

  // Removed people
  "vaultSettings.section.people": "اشخاص",
  "vaultSettings.row.removedPeople": "اشخاص حذف‌شده",
  "peopleRemoved.title": "اشخاص حذف‌شده",
  "peopleRemoved.empty": "شخص حذف‌شده‌ای نیست.",
  "peopleRemoved.emptySubtitle":
    "کسانی را که حذف می‌کنید با ثبت‌هایشان اینجا می‌مانند و قابل بازگردانی‌اند.",
  "peopleRemoved.emptyCta": "بازگشت",
  "peopleRemoved.removedAt": "حذف شده {relative}",
  "peopleRemoved.entryCount": "{n} ثبت",
  "peopleRemoved.entryCount.one": "1 ثبت",
  "peopleRemoved.restoreButton": "بازگردانی",
  "peopleRemoved.restoredToast": "{name} به کتاب شما برگشت",
  "peopleRemoved.restoreFailed": "بازگردانی نشد. دوباره تلاش کنید.",
  "peopleRemoved.relative.justNow": "همین حالا",
  "peopleRemoved.relative.minutesAgo": "{n} دقیقه پیش",
  "peopleRemoved.relative.hoursAgo": "{n} ساعت پیش",
  "peopleRemoved.relative.daysAgo": "{n} روز پیش",
  "peopleRemoved.relative.monthsAgo": "{n} ماه پیش",
};

const TABLES = { en, fa } as const;
export type LocaleCode = keyof typeof TABLES;

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

// ---- Message language (share pipeline) ----
// Outgoing messages (WhatsApp ledger ping, invite link) and the shared-ledger
// web page can be in a different language than the app UI — most shopkeepers
// keep the app in English but message customers in Dari. Preference lives in
// app_meta under "share_lang_pref":
//   'auto' — follow the app language (default; the pre-setting behavior)
//   'ask'  — a picker sheet asks before every send
//   'en' / 'fa' — always that language
export type ShareLangPref = "auto" | "ask" | LocaleCode;

export async function getShareLangPref(): Promise<ShareLangPref> {
  try {
    const v = await getAppMeta("share_lang_pref");
    return v === "ask" || v === "en" || v === "fa" ? v : "auto";
  } catch {
    return "auto";
  }
}

// Resolve a non-'ask' preference to a concrete locale. 'ask' never reaches
// here — callers surface the picker sheet and pass the user's choice instead.
export function resolveShareLang(pref: Exclude<ShareLangPref, "ask">): LocaleCode {
  return pref === "auto" ? getLocale() : pref;
}

// Look up a string for the active locale. Falls back to English if the key
// is missing from the localized table (e.g., during partial translation).
// `vars` substitutes `{placeholder}` tokens with their string values.
export function t(key: Key, vars?: Record<string, string | number>): string {
  return tIn(currentLocale, key, vars);
}

// Same lookup for an explicit locale, independent of the app UI language.
// Used by lib/share.ts so a message can be composed in the user's chosen
// message language. Do NOT emulate this by flipping setLocale() around a
// call — that notifies subscribers and re-renders every useIsRTL consumer.
export function tIn(locale: LocaleCode, key: Key, vars?: Record<string, string | number>): string {
  const localized = TABLES[locale][key];
  const template = (localized && localized.length > 0 ? localized : en[key]) ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}

/**
 * True when a self display name is the restore-time placeholder minted by
 * ensureLocalSelfForRestore ("You"/"شما") rather than a name the user or
 * their sign-in provider actually supplied. Checked against BOTH locales'
 * literals — the mint uses the active UI locale, but the user may switch
 * languages later. Callers use this to avoid propagating the placeholder
 * into signed events, member mirrors, or WhatsApp-visible surfaces.
 */
export function isPlaceholderSelfName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === tIn("en", "recovery.selfPlaceholderName") ||
    trimmed === tIn("fa", "recovery.selfPlaceholderName")
  );
}

// Re-evaluate the locale after the user (eventually) toggles a manual
// override. Currently device-driven only.
export function refreshLocale(): void {
  currentLocale = pickLocale();
}
