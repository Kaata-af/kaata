import { getLocales } from "expo-localization";
import { getAppMeta } from "./db";

// Flat translation tables for English, Dari and Pashto. Locale preferences are
// loaded before the first app frame, while static lookups remain available on
// recovery screens even if the preference database cannot open.
//
// Layout direction is controlled by lib/direction.ts; bundled Vazirmatn fonts
// support all three languages. Outgoing messages can use a separate language
// through tIn(), without changing the active UI language.

// Source-of-truth English strings. All other locales must use the same keys.
const en = {
  "selection.start": "Select",
  "selection.contacts": "Select contacts",
  "selection.tallies": "Select tallies",
  "selection.count": "{count} selected",
  "selection.all": "Select all",
  "selection.clear": "Deselect all",
  "selection.allResults": "Select all results",
  "selection.clearResults": "Deselect results",
  "selection.close": "Done",
  "selection.hint": "Double tap to select or deselect this item.",
  "selection.removeContactsTitle": "Remove {count} contacts?",
  "selection.removeContactsDescription":
    "These contacts will be hidden in this kaata. You can restore them from Removed people.",
  "selection.contactsRemoved": "{count} contacts removed",
  "selection.deleteTalliesTitle": "Delete {count} tallies?",
  "selection.deleteTalliesDescription":
    "These tallies will be deleted and the balances will update. This cannot be undone.",
  "selection.talliesDeleted": "{count} tallies deleted",
  "selection.partialFailure": "{count} items could not be updated. Try again.",
  "selection.remove": "Remove",
  "selection.delete": "Delete",
  "selection.empty": "Tap items to select them",
  "selection.summary.transactions": "{count} transactions",
  "selection.summary.transaction": "{count} transaction",
  "selection.summary.transactionsLabel": "Transactions",
  "selection.summary.debt": "Total debt",
  "selection.summary.credit": "Total credit",
  "selection.summary.remaining": "Remaining balance",
  "selection.summary.collect": "Remaining to collect",
  "selection.summary.pay": "Remaining to pay",
  "selection.summary.unavailable": "Some selected account data isn't available on this phone.",
  "inbox.title": "Notifications",
  "inbox.bell": "Notifications, {count} unread",
  "inbox.unread": "Unread",
  "inbox.markAll": "Mark all read",
  "inbox.seeAll": "See all notifications",
  "inbox.empty": "You're all caught up. Shared-account updates will appear here.",
  "inbox.unavailable": "Connect to load your notifications.",
  "inbox.signIn": "Sign in to see your shared-account notifications.",
  "inbox.failed": "Couldn't refresh notifications.",
  "inbox.retry": "Tap to retry.",
  "inbox.openFailed": "Couldn't open this account. Check your connection and access.",
  "tab.notify.detail.new": "{name} added a tally ({amount}). Accept or reject it.",
  "tab.notify.detail.accepted": "Your tally ({amount}) was accepted by {name}.",
  "tab.notify.detail.rejected":
    "Your tally ({amount}) was rejected by {name}. Excluded from the balance.",
  "tab.notify.detail.voided": "{name} voided a tally ({amount}).",
  // Onboarding
  "onboarding.subtitle": "A personal ledger between you and the people you trust.",
  "onboarding.name.label": "Your name",
  "onboarding.name.placeholder": "Sultan",
  "onboarding.lastName.label": "Last name",
  "onboarding.lastName.placeholder": "Ahmadi",
  "onboarding.phone.label": "Phone number",
  "onboarding.phone.required": "Phone number is required",
  "onboarding.phone.hint": "Helps your team find you when linking devices.",
  "onboarding.continue": "Continue",
  "onboarding.nameRequired": "Name required",
  // Fallback display name for a self identity reconstructed during cloud restore
  // when neither the Google name nor the restored owner name is available (rare).
  "recovery.selfPlaceholderName": "You",

  // Onboarding step 1 — language picker. Only shown when device locale
  // isn't already Persian/Dari.
  "onboardingLanguage.title": "Choose your language",
  "onboardingLanguage.subtitle":
    "Choose the language you prefer. You can change it later in Account.",

  // Sign-in follows language/calendar; profile and kaata creation come next.
  "onboardingMode.title": "Get started with Kaata",
  "onboardingMode.subtitle": "Choose how to save and access your accounts.",
  // The two offers are explained ONCE each, above their buttons — the backup
  // sentence used to be duplicated on the Google and Apple cards.
  "onboardingMode.account.label": "With an account",
  "onboardingMode.account.body":
    "Back up your kaatas, restore them on a new phone, and use them across your devices.",
  "onboardingMode.google.title": "Sign in with Google",
  "onboardingMode.apple.title": "Sign in with Apple",
  "onboardingMode.offline.label": "Ninja mode",
  "onboardingMode.offline.body":
    "Stay in the shadows. No account needed. Keep your kaata on this phone, and sign in later for cloud backup.",
  "onboardingMode.offline.title": "Continue in ninja mode",
  "onboardingMode.offline.warning":
    "No account backup in ninja mode. If you lose this phone, you could lose all your data. Sign in later to back it up.",
  // Sign-in failures now name the leg that broke and carry a short code
  // (e.g. "server 503", "timeout") the user can read out for support.
  "onboardingMode.signInFailed": "Sign-in didn't work. Try again.",
  "onboardingMode.signInFailed.network":
    "Sign-in couldn't reach Kaata. Check your internet and try again.",
  "onboardingMode.signInFailed.playServices":
    "This phone needs a newer Google Play Services to sign in. Update it in the Play Store, or continue without an account.",
  "onboardingMode.expoGoHint":
    "Sign-in works on the real app; for now you can continue in ninja mode.",
  "onboardingMode.back": "Back",
  // Kaata's own accounts: email + password (docs/kaata-accounts.md §7,
  // components/EmailAuthFlow.tsx). Play's review instructions quote
  // "Continue with email" word for word: change both together.
  "onboardingMode.email.title": "Continue with email",
  "auth.email.signIn.title": "Sign in with email",
  "auth.email.signIn.subtitle": "Use the email or username and the password of your Kaata account.",
  "auth.email.identifier": "Email or username",
  "auth.email.password": "Password",
  "auth.email.signIn.submit": "Sign in",
  "auth.email.forgot": "Forgot password?",
  "auth.email.toSignUp": "Create an account",
  "auth.email.toSignIn": "Already have an account? Sign in",
  "auth.email.signUp.title": "Create a Kaata account",
  "auth.email.signUp.subtitle": "We'll email you a 6-digit code to confirm the address.",
  "auth.email.email": "Email",
  "auth.email.newPassword": "Kaata password",
  "auth.email.newPassword.helper": "Make a new password for Kaata, not your Gmail password",
  "auth.email.sendCode": "Send code",
  "auth.email.gmail": "Continue with Google: no password needed",
  "auth.email.providerHint": "Joined with Google or Apple? Use that button.",
  "auth.email.code.title": "Check your email",
  "auth.email.code.sent":
    "We sent a 6-digit code to {email}. If this address already has a Kaata account, the email says how to sign in instead.",
  "auth.email.code.label": "6-digit code",
  "auth.email.code.spam": "Nothing after a minute? Check your Spam folder.",
  "auth.email.code.resend": "Send a new code",
  "auth.email.code.resendIn": "Send a new code in {time}",
  "auth.email.code.resent": "A new code is on its way.",
  "auth.email.code.changeEmail": "Change email",
  "auth.email.code.passwordAgain": "Type the Kaata password you chose again.",
  "auth.email.code.submit": "Create account",
  "auth.email.forgot.title": "Reset your password",
  "auth.email.forgot.subtitle":
    "Enter the email you sign in with. If it has a Kaata password, we'll send a code to reset it.",
  "auth.email.backToSignIn": "Back to sign in",
  "auth.email.reset.title": "Choose a new password",
  "auth.email.reset.sent":
    "If {email} has a Kaata password, we sent it a 6-digit code. Enter the code and a new password.",
  "auth.email.reset.newPassword": "New password",
  "auth.email.reset.submit": "Save and sign in",
  "auth.email.required": "Enter your email address.",
  "auth.email.identifierRequired": "Enter your email or username.",
  "auth.email.passwordRequired": "Enter your password.",
  "auth.email.codeRequired": "Enter the 6-digit code from the email.",
  "auth.password.show": "Show password",
  "auth.password.hide": "Hide password",
  "auth.password.rule.length": "8 or more characters",
  "auth.password.rule.digits": "Not only numbers, unless 12 or more",
  "auth.password.rule.runs": "No easy runs like 123456 or aaaaaa",
  "auth.password.rule.personal": "Not a common password, and not your email",
  // Every refusal of docs/kaata-accounts.md §6, as lib/account-rules.ts words it.
  "auth.error.email.format": "Enter a valid email address, like name@example.com.",
  "auth.error.email.relay":
    "Apple's hidden relay address can't be used here. Enter your own email address.",
  "auth.error.email.disposable":
    "Temporary email addresses can't be used. Enter an address you'll keep.",
  "auth.error.email.required": "Enter an email address to sign in with.",
  "auth.error.email.inUse": "Another Kaata account uses this email. Enter a different address.",
  "auth.error.password.too_short": "Use at least 8 characters.",
  "auth.error.password.too_long": "Use 128 characters or fewer.",
  "auth.error.password.whitespace": "Remove the space at the start or end of the password.",
  "auth.error.password.common": "That password is too common. Choose one that's harder to guess.",
  "auth.error.password.personal": "Don't put your email, username or phone number in the password.",
  "auth.error.password.pattern": "Avoid easy patterns like 123456, aaaaaa or only numbers.",
  "auth.error.password.weak": "Choose a stronger password.",
  "auth.error.code.invalid":
    "That code isn't right or has expired. Use the newest email, or send a new code.",
  "auth.error.accountExists": "There's already a Kaata account for this email. Sign in instead.",
  "auth.error.invalidCredentials": "That email, username or password isn't right.",
  "auth.error.wrongPassword": "Your current password isn't right.",
  "auth.error.noPassword": "This account doesn't have a Kaata password yet.",
  "auth.error.passwordExists": "This account already has a Kaata password.",
  "auth.error.username.format":
    "Use 3 to 30 lowercase letters, numbers, _ or ., starting with a letter.",
  "auth.error.username.reserved": "That username isn't available. Choose another.",
  "auth.error.username.taken": "That username is taken. Choose another.",
  "auth.error.name.invalid": "Your name must be 2 to 60 characters.",
  "auth.error.name.provider": "Your name comes from Google or Apple.",
  "auth.error.tooManyAttempts": "Too many tries. Wait a few minutes, then try again.",
  "auth.error.tooManyAttempts.wait": "Too many tries. Try again in {time}.",
  "auth.error.tooManyEmails": "Too many requests for this email. Wait a while, then try again.",
  "auth.error.tooManyEmails.wait": "Too many requests for this email. Try again in {time}.",
  "auth.error.rateLimited": "Too many tries. Wait a few minutes, then try again.",
  "auth.error.rateLimited.wait": "Too many tries. Try again in {time}.",
  "auth.error.emailUnavailable":
    "Email codes can't be sent right now. Use Google or Apple, or try again later.",
  "auth.error.busy": "Kaata is busy. Try again in a moment.",
  "auth.error.accountDisabled": "This account has been disabled.",
  "auth.error.accountDeletionExpired":
    "The 30-day recovery period has ended. This account is being permanently deleted.",
  "auth.error.sessionExpired": "You've been signed out. Sign in again, then try once more.",
  "auth.error.emailFixed": "Your password must use your account's email address.",
  "auth.error.providerSessionRequired": "Sign in with Google or Apple to remove the password.",
  "auth.error.tokenExpired": "Sign-in took too long. Please sign in again.",
  "auth.wait.seconds": "{n} seconds",
  "auth.wait.minute": "1 minute",
  "auth.wait.minutes": "{n} minutes",
  "auth.wait.hour": "1 hour",
  "auth.wait.hours": "{n} hours",

  // Onboarding profile (last step before the tour)
  // Was "Almost done" — mistimed once the kaata step landed after this
  // screen, and it described progress instead of saying what the screen IS.
  "onboardingProfile.title": "Your profile",
  "onboardingProfile.subtitle": "Help the people you share accounts with recognize you.",
  "onboardingProfile.signedInHint": "Signed in as {email}",
  "onboardingProfile.continue": "Continue",
  "onboardingProfile.nameRequired": "Please enter your name",
  "onboardingProfile.shopRequired": "Please name your Kaata",
  "onboardingProfile.joinExisting": "I'll join an existing kaata instead",

  // A kaata holds everyone's accounts for a shop, household, or another purpose.
  "onboardingKaata.title": "Name your kaata",
  "onboardingKaata.subtitle":
    "A kaata keeps everyone's accounts in one place. Give it a name for your shop or household.",
  "onboardingKaata.name.label": "Kaata name",
  "onboardingKaata.name.placeholder": "Ahmad Grocery Store",
  "onboardingKaata.name.required": "Please name your kaata",
  "onboardingKaata.currency.label": "Currency",
  "onboardingKaata.currency.hint":
    "Default currency for new tallies. You can use other currencies in this Kaata.",
  "onboardingKaata.submit": "Create my kaata",

  // Quiet confirmation after the first kaata is created, with one next step.
  "onboardingSuccess.title": "Your kaata is ready",
  "onboardingSuccess.body":
    "Add a person, then record what you give or receive. Kaata keeps the balance for you.",
  "onboardingSuccess.ledgerLabel": "Your kaata",
  "onboardingSuccess.cta": "Open my kaata",

  // Permanent guide screen (app/guide.tsx), linked from the settings sheet.
  "guide.title": "How kaata works",
  "guide.p1": "A kaata is your shop's ledger book. One kaata holds all the accounts of one shop.",
  "guide.p2":
    "Each person you keep accounts with — customer or supplier — gets one tally inside your kaata. Add them with the button at the bottom right.",
  "guide.p3":
    "On a person's tally, record I gave when you hand over money or goods, and I received when they pay you back. The balance updates by itself.",
  "guide.p4":
    "Running more than one shop? Create another kaata and switch between them by tapping the kaata name at the top of the home screen.",

  // Onboarding restore (inserted between auth and profile when the
  // backend has existing ledger state for the signed-in account).
  "onboardingRestore.title": "Welcome back",
  "onboardingRestore.checking": "Finding your kaatas",
  "onboardingRestore.checkingHint": "Checking your account for saved data.",
  // M5 multi-vault recovery: the count of non-archived vaults the account
  // belongs to. {count} is always >= 1 on this screen.
  "onboardingRestore.subtitleVaults": "Kaatas saved to your account: {count}",
  "onboardingRestore.restore.title": "Restore from cloud",
  "onboardingRestore.restore.bodyVaults":
    "Bring your people, transactions, and kaatas back to this phone.",
  "onboardingRestore.fresh.title": "Start fresh",
  "onboardingRestore.fresh.body":
    "Create a new kaata instead. Your saved kaatas stay in the cloud.",
  "onboardingRestore.fresh.confirmTitle": "Start with a clean ledger?",
  "onboardingRestore.fresh.confirmBody":
    "Your backed-up kaatas stay safe in the cloud, but they won't be restored to this phone now. You can sign in again later to restore them.",
  "onboardingRestore.restoring": "Restoring your kaata…",
  "onboardingRestore.tryAgain": "Try again",
  "onboardingRestore.startFresh": "Start fresh",
  "onboardingRestore.errorTitle": "Couldn't restore",
  "onboardingRestore.errorSessionExpired": "Your sign-in expired. Sign in again to restore.",
  "onboardingRestore.signInAgain": "Sign in again",
  "onboardingRestore.errorTimeout": "Network was too slow. Try again on a better connection.",
  "onboardingRestore.errorGeneric": "Something went wrong. Try again.",

  // First-time guided tour was deprecated — keys removed. See
  // docs/tour-redesign.md for the postmortem + the recommended
  // approach for a future attempt.

  // Profile menu — only keys referenced by ProfileSettingsSheet remain.
  // The signedInAs/notSignedIn/account/accountHint keys belonged to the
  // killed /account screen (Phase 7 D-ACCOUNT-PAGE-ROLE) and were dropped.
  // The preferences row was folded into /vault/settings (Manage this Kaata).

  // "Different account on this phone?" (docs/kaata-accounts.md §7): the server
  // asks for every provider, Google, Apple and email alike, so the words name
  // none. {oldEmail} and {newEmail} arrive LTR-isolated.
  "account.differentAccount.title": "Different account on this phone",
  "account.differentAccount.body":
    "This phone is linked to {oldEmail}. You're signing in to {newEmail}. What do you want to do?",
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
  "home.total.title": "Balances",
  "home.total.label.pay": "To pay",
  "home.total.nextCurrency": "Next currency",
  "home.total.previousCurrency": "Previous currency",
  "home.total.pending":
    "Shared accounts are still downloading. Totals will appear when they're ready.",
  "home.empty.title": "No customers yet",
  "home.empty.subtitle": "Add a customer to start keeping tallies.",
  "home.empty.collect.title": "Nothing to collect yet",
  "home.empty.collect.subtitle":
    "Tap the button at the bottom right to add a tally for someone you keep accounts with — one per customer.",
  "home.empty.pay.title": "You owe no one yet",
  "home.empty.pay.subtitle":
    "When you take goods or borrow money, log it from that person's page and they'll appear here.",
  "home.from.someone": "from {count} person",
  "home.from.many": "from {count} people",

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
  "person.ping.button": "Send WhatsApp reminder",
  "person.ping.hint": "Share the balance and recent tallies with {name}.",
  "person.ping.preparing": "Preparing your reminder…",
  "person.ping.opening": "Opening WhatsApp…",
  "person.search.placeholder": "Search notes or amounts",
  "person.search.clear": "Clear search",
  "person.date.title": "Filter by date",
  "person.date.all": "All dates",
  "person.date.today": "Today",
  "person.date.last7": "Last 7 days",
  "person.date.last30": "Last 30 days",
  "person.date.month": "This month",
  "person.date.custom": "Custom range",
  "person.date.pickStart": "Choose a start date",
  "person.date.pickEnd": "Choose an end date, or tap the same day again for one day",
  "person.date.rangeReady": "Tap a date to start a new range",
  "person.date.chooseRange": "Choose two dates for the range",
  "person.date.startTime": "Start time",
  "person.date.endTime": "End time",
  "person.date.invalidTimes": "Choose valid times with the end at or after the start.",
  "person.date.timeUnavailable": "Couldn't open the time picker. Try again.",
  "person.date.apply": "Apply range",
  "person.date.clear": "Clear date filter",
  "person.date.active": "Date filter: {range}",
  "person.date.previousMonth": "Previous month",
  "person.date.nextMonth": "Next month",
  "person.date.weekday.0": "Su",
  "person.date.weekday.1": "Mo",
  "person.date.weekday.2": "Tu",
  "person.date.weekday.3": "We",
  "person.date.weekday.4": "Th",
  "person.date.weekday.5": "Fr",
  "person.date.weekday.6": "Sa",
  "customers.listOptions": "Sort & filter",
  "customers.search": "Search customers",
  "search.openHint": "Opens search and filters with matching results.",
  "search.filters": "Filters",
  "search.showResults": "Show results",
  "search.clearQuery": "Clear search",
  "search.clearAll": "Clear all filters",
  "customers.search.clear": "Clear customer search",
  "customers.search.title": "Search results",
  "customers.search.result": "1 matching customer",
  "customers.search.results": "{count} matching customers",
  "customers.noResults": "No matching customers",
  "customers.noTallies": "No tallies yet",
  "customers.balanceFilter": "Balances",
  "customers.balanceFilter.all": "All customers",
  "customers.balanceFilter.collect": "To collect only",
  "customers.balanceFilter.pay": "To pay only",
  "customers.balanceFilter.help":
    "Matches any currency. A customer with different currency balances can appear in both filters.",
  "customers.balanceFilter.clear": "Clear balance filter",
  "customers.sort": "Sort customers",
  "customers.sort.multiCurrencyHelp":
    "Amount sorting is available when balances use a single currency.",
  "customers.sort.outstanding_name": "Balances first · A–Z",
  "customers.sort.recent": "Recent activity",
  "customers.sort.name_asc": "Name · A–Z",
  "customers.sort.name_desc": "Name · Z–A",
  "customers.sort.amount_desc": "Amount · largest first",
  "customers.sort.amount_asc": "Amount · smallest first",
  "customers.sort.date_asc": "Last tally · oldest first",
  "customers.filtered": "{direction}: {shown} of {total} customers · {amount} of the total above",
  "groups.filter": "Groups",
  "groups.filterHelp": "Choose groups to show customers in any of them.",
  "groups.all": "All customers",
  "groups.ungrouped": "Ungrouped",
  "groups.none": "No group",
  "groups.manage": "Manage groups",
  "groups.help":
    "Create your own groups for this kaata. Each customer can belong to several groups. Groups organize the list; they do not change access or balances.",
  "groups.personAction": "Customer groups",
  "groups.personHelp": "Choose one or more groups for this customer in this kaata.",
  "groups.members.help":
    "Tick customers to put them in this group, untick to take them out. Changes are saved with Done or when you go back.",
  "groups.members.viewHelp": "Customers in this group.",
  "groups.members.search": "Search customers",
  "groups.members.none": "No customers in this group yet.",
  "groups.members.missing": "This group is no longer available.",
  "groups.members.open": "Shows who is in this group",
  "groups.memberCountOne": "{count} customer",
  "groups.memberCount": "{count} customers",
  "groups.edit": "Edit {name}",
  "groups.empty": "No groups yet.",
  "groups.name": "Group name",
  "groups.namePlaceholder": "e.g. Family or West neighborhood",
  "groups.nameInvalid": "Use a group name of 1–40 characters.",
  "groups.nameDuplicate": "A group with this name already exists.",
  "groups.add": "Add group",
  "groups.rename": "Rename group",
  "groups.archive": "Remove group",
  "groups.archiveTitle": "Remove {name}?",
  "groups.archiveHelp":
    "Customers keep their other groups. Their tallies and balances stay the same.",
  "customers.noGroupResults": "No customers from the selected groups on this side.",
  "groups.view": "Group: {name}",
  "groups.viewMany": "Groups: {name}",
  "groups.clearFilter": "Shows all customers again",
  "reminders.channel": "Customer reminders",
  "credit.title": "Credit limits",
  "credit.defaultTitle": "Default credit limit",
  "credit.defaultHelp":
    "Applies to every customer without their own limit, including customers added later. A customer's own limit always wins.",
  "credit.usesDefault":
    "This customer has no limit of their own, so the kaata's default limit applies. Saving here gives them their own.",
  "credit.defaultRow": "Default credit limit",
  "credit.defaultRowHint": "For customers without their own limit",
  "credit.maxCollect": "Maximum they owe us",
  "credit.maxPay": "Maximum we owe them",
  "credit.unlimited": "No limit",
  "credit.warnMode": "Warn only",
  "credit.hardMode": "Restrict clerks",
  "credit.editorsMode": "Restrict editors and clerks",
  "credit.modeHelp":
    "Choose a warning or a restriction. Individual member permissions can change who must obey a hard limit.",
  "credit.hardHelp":
    "Staff covered by a hard limit need an online check for tallies that change their exposure. Tallies that reduce an existing debt remain allowed. Owners and admins can exceed limits; member exceptions apply only to hard limits.",
  "credit.forCustomer": "For {name}",
  "credit.zeroHelp":
    "Leave a field blank for no limit. 0 means no credit at all in that direction.",
  "credit.loadFailed": "Could not load the limits. Go back and open them again.",
  "credit.limitLeft": "Limit {limit} · {left} left",
  "credit.limitOver": "Limit {limit} · {over} over",
  "credit.clerksNeedSignIn":
    "Ask every restricted staff member to sign in and sync before enabling restrictions.",
  "credit.warning": "This tally exceeds the credit limit",
  "credit.blocked": "Credit limit exceeded. This tally was not recorded.",
  "credit.pending": "Waiting for server confirmation",
  "credit.pendingChange":
    "This change is waiting for server confirmation. The recorded tally is unchanged.",
  "credit.refusedChange":
    "This change was refused because it exceeds a credit limit. The recorded tally is unchanged.",
  "credit.intentEdit": "Edit tally",
  "credit.intentDelete": "Delete tally",
  "credit.pendingHold":
    "Waiting for the server to check the limit. Hand nothing over until it's confirmed.",
  "credit.signInToSend": "Not sent: sign in so the server can check it",
  "credit.refusalOne": "The limit stopped a tally by {name}: {what}, {when}",
  "credit.refusalMany":
    "The limit stopped {count} tallies in the last 30 days. Latest by {name}: {what}, {when}",
  "credit.refusalSomeone": "a staff member",
  "tab.savedSignIn": "Saved on this phone. Sign in to send it to {name}.",
  "credit.refused": "Credit limit exceeded — not recorded",
  "credit.intentsTitle": "Waiting / not recorded",
  "credit.onlineSave":
    "Once you're signed in, every save of a limit needs a connection, so all phones get the same rule.",
  "credit.saveFailed": "Could not save the limits. Check your connection and try again.",
  "credit.limitInvalid": "Enter zero or a positive amount with up to two decimals",
  "credit.recorded": "Recorded",
  "credit.statusOver": "Over credit limit",
  "credit.statusNear": "Near credit limit",
  "credit.save": "Save limits",
  "credit.saved": "Credit limits saved",
  "reminders.title": "Reminders",
  "reminders.personal": "Only for you on this phone. Nothing is sent to the customer.",
  "reminders.add": "Add reminder",
  "reminders.edit": "Edit reminder",
  "reminders.once": "Once",
  "reminders.daily": "Every day",
  "reminders.weekly": "Every week",
  "reminders.monthly": "Monthly",
  "reminders.chooseWeekdays": "Choose any days you want.",
  "reminders.chooseOneDay": "Choose at least one day.",
  "reminders.repeatEvery": "Repeat every",
  "reminders.oneMonth": "1 month",
  "reminders.monthCount": "{months} months",
  "reminders.monthlyDate": "Repeating day and month (Gregorian)",
  "reminders.monthlyCalendar":
    "Monthly reminders follow the Gregorian calendar. Choose day 1–28 so every month has that date.",
  "reminders.monthDayRange": "Choose a day from 1 to 28.",
  "reminders.onMonthlyDay": "Day {day} of every Gregorian month at {time}",
  "reminders.onMonthInterval": "Every {months} Gregorian months, day {day}, at {time}",
  "reminders.scheduleLimit":
    "This phone has no notification slots left for this schedule. Choose fewer weekdays or a longer interval, or remove another reminder.",
  "reminders.date": "Date",
  "reminders.time": "Time",
  "reminders.weekday": "Day of week",
  "reminders.everyDay": "Every day at {time}",
  "reminders.everyWeekday": "Every {weekday} at {time}",
  "reminders.next": "Next: {date}",
  "reminders.due": "Due",
  "reminders.dueShortcut": "Reminders due: {count}",
  "reminders.all": "All",
  "reminders.empty": "No reminders here yet.",
  "reminders.noDue": "No reminders are due.",
  "reminders.markDone": "Mark done",
  "reminders.remove": "Remove reminder",
  "reminders.removeConfirm": "Remove this reminder?",
  "reminders.saved": "Reminder saved.",
  "reminders.future": "Choose a future date and time.",
  "reminders.unavailable": "This customer is no longer available.",
  "reminders.permissionDenied": "Saved. Notifications are off; this reminder will appear in Kaata.",
  "reminders.notificationsOff":
    "Notifications are off for Kaata, so reminders only show inside the app. Turn them on in Settings to be alerted on time.",
  "reminders.permissionUnavailable": "Saved. This build supports reminders inside Kaata.",
  "reminders.nativeFailed":
    "Saved. Phone notifications could not be scheduled; the reminder remains in Kaata.",
  "reminders.limit": "This phone can have up to 40 active reminders.",
  "reminders.loadFailed":
    "Reminders couldn't be read on this phone. Try again; if it keeps failing, restart Kaata.",
  "reminders.notifyBody": "A customer reminder is due. Open Kaata to view it.",
  "reminders.notifyBodyNamed": "Time to notify {name} about their tally. Open Kaata to send it.",
  "person.flows.allTime": "All time",
  "person.flows.gave": "I gave ({count})",
  "person.flows.received": "I received ({count})",
  "person.flows.hint":
    "Recorded gives and receives across available history. Opening balances are not counted as new handovers.",
  "onboardingCalendar.title": "Choose your calendar",
  "onboardingCalendar.subtitle": "Use the dates you know. You can change this later in Account.",
  "person.search.result": "{count} matching tally · balance includes all tallies",
  "person.search.results": "{count} matching tallies · balance includes all tallies",
  "person.search.empty.title": "No matching tallies",
  "person.search.empty.subtitle": "Try another note or amount, or clear the filters.",
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
  "personAdd.new": "Add person",
  "personFind.title": "Find person",
  "personFind.placeholder": "Search by name or number",
  "personFind.empty.subtitle": "People added to this Kaata will appear here.",
  "personAdd.firstName.placeholder": "Ahmad",
  "personAdd.lastName.placeholder": "Karimi",
  "personAdd.add": "Add {name}",
  "personAdd.phone.hint": "Needed to send pings on WhatsApp.",
  "personAdd.phone.invalid":
    "Enter a phone number for the selected country, or include + and its country code.",
  "personAdd.phone.conflict": "Phone already used by {name}",
  "personAdd.phone.isSelf": "That's your own number — you can't add yourself.",
  "personAdd.save.storageFull": "Your phone's storage is full. Free up some space and try again.",
  "personAdd.save.storageBusy": "Kaata is busy saving changes. Wait a moment and try again.",
  "personAdd.save.failed":
    "Couldn't finish saving this person. Reopen Kaata and try again. If it keeps happening, share an App health report.",
  "personAdd.section.matches": "Matches",
  "personAdd.section.existing": "Already in this kaata",
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
  "personAdd.contacts.manage": "Choose more contacts in Settings",
  "personAdd.contacts.failed":
    "Couldn't open Settings. You can allow contacts access from your phone's Settings app.",
  // Overflow row under the truncated Matches list — invites the user to
  // refine the search instead of scrolling an unbounded result set.
  "personAdd.moreResults": "+{count} more — keep typing to narrow",
  "personAdd.moreContacts": "Type a name or number to find more contacts.",

  // Tally calculator
  "calculator.open": "Open calculator",
  "calculator.title": "Calculator",
  "calculator.close": "Close calculator",
  "calculator.nextNote": "Go to note",
  "calculator.useAmount": "Use amount",
  "calculator.expression": "Calculation",
  "calculator.result": "Result",
  "calculator.history": "History",
  "calculator.historyTitle": "Calculations for this tally",
  "calculator.historyEmpty": "Your calculations will appear here.",
  "calculator.clearHistory": "Clear history",
  "calculator.backToCalculator": "Back to calculator",
  "calculator.recallCalculation": "Reuse calculation: {expression}",
  "calculator.clear": "Clear all",
  "calculator.delete": "Delete last digit",
  "calculator.add": "Add",
  "calculator.subtract": "Subtract",
  "calculator.multiply": "Multiply",
  "calculator.divide": "Divide",
  "calculator.percent": "Percent",
  "calculator.equals": "Calculate result",
  "calculator.sign": "Change sign",
  "calculator.parentheses": "Parentheses",
  "calculator.doubleZero": "Double zero",
  "calculator.decimal": "Decimal point",
  "calculator.memory": "Memory",
  "calculator.memoryClear": "Clear memory",
  "calculator.memoryRecall": "Recall memory",
  "calculator.memoryAdd": "Add result to memory",
  "calculator.memorySubtract": "Subtract result from memory",
  "calculator.invalid": "Check the calculation.",
  "calculator.divisionByZero": "Cannot divide by zero.",
  "calculator.tooComplex": "This calculation is too long. Remove a few terms.",
  "calculator.tooLarge": "This amount is too large for a tally.",
  "calculator.positiveAmount": "Use an amount greater than zero.",
  "calculator.incomplete": "Finish the calculation to use the amount.",
  "calculator.rounded": "Rounded to 2 decimal places",
  "calculator.memoryEmpty": "Memory is empty",
  "calculator.helper": "Calculate here, then use the amount in your tally.",

  // Entry
  "entry.amount.label": "Amount (AFN)",
  "entry.note.label": "Note",
  "entry.date.label": "Date",
  "entry.more.show": "Show more",
  "entry.more.hide": "Show less",
  "entry.currency.label": "Currency",
  "entry.currency.fixed":
    "Currency stays with this tally. Add a new tally to use another currency.",
  "entry.currency.disabled":
    "This currency is no longer enabled for this Kaata. Choose an enabled currency.",
  "currency.view": "Viewing",
  "entry.note.placeholder": "Flour and tea",
  "entry.save": "Save",
  "entry.saveChanges": "Save changes",
  "entry.context.to": "to",
  "entry.context.from": "from",
  "entry.edit.title": "Edit · {verb}",
  "entry.edit.hint":
    'Direction can\'t be changed. To turn this into "{otherVerb}", delete this entry and add a new one.',
  "entry.notFound": "This entry no longer exists.",
  "entry.showExactTime": "Show exact date and time",
  "entry.showRelativeTime": "Show relative time",
  "entry.options": "Tally options",
  // Attribution on a shared kaata's tally row. The collapsed row shows only a
  // tinted initial; these words appear when the row is opened, and as the
  // chip's screen-reader label. `entry.editedBy` is lower-case on purpose —
  // it only ever follows "Added by X · ".
  "entry.addedBy": "Added by {name}",
  "entry.editedBy": "edited by {name}",
  "entry.editedByOnly": "Edited by {name}",
  "entry.by.you": "you",
  "entry.by.self": "{name} (you)",
  // When the member's name hasn't reached this device yet. Better than a
  // truncated account id, which reads as a bug rather than as a person.
  "entry.by.someone": "another member",
  "entry.invalidAmount": "Enter a positive amount with up to 2 decimal places",
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
  // Shown when a save can't be signed (EventSigningUnavailableError, from a
  // DeviceKeyUnavailableError in lib/mesh/device-key.ts): the SecureStore
  // read threw (locked keychain, Keystore hiccup), the store refused a write,
  // or a repair was needed while another transaction was open. A plain retry
  // usually succeeds — the save path repairs the key in place — so lead
  // with that; reopening is the fallback. Actionable, unlike saveFailed.
  "entry.signingUnavailable":
    "Couldn't prepare a secure save. Try again — if it keeps failing, reopen Kaata.",

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
  "settings.language.option.ps": "پښتو",
  "settings.language.changed": "Language updated.",

  // Calendar system. Independent of language: the app supports Dari with
  // Gregorian dates and English with Solar Hijri dates, because the calendar
  // is a bookkeeping convention and the language is a reading preference.
  // "Automatic" resolves to Solar Hijri when the app language is Dari — the
  // behaviour that shipped before this setting existed, so it is the default
  // and nobody's dates move on upgrade.
  "settings.calendar.label": "Calendar",
  "settings.calendar.option.auto": "Automatic",
  "settings.calendar.option.gregorian": "Gregorian",
  "settings.calendar.option.jalali": "Solar Hijri",
  "settings.calendar.option.qamari": "Lunar Hijri (Qamari)",
  "settings.calendar.hint.qamari":
    "Calculated calendar. If your moon sighting differs, adjust it in Account.",
  "settings.qamariOffset.label": "Adjust Qamari date",
  "settings.qamariOffset.hint": "For when the date is a day off from your moon sighting",
  "settings.qamariOffset.none": "No change",
  "settings.qamariOffset.later1": "1 day later",
  "settings.qamariOffset.later2": "2 days later",
  "settings.qamariOffset.earlier1": "1 day earlier",
  "settings.qamariOffset.earlier2": "2 days earlier",
  "settings.qamariOffset.changed": "Qamari dates adjusted",
  // Subtitles carry a live example, which is the only thing that actually
  // tells a shopkeeper what they are picking.
  "settings.calendar.hint.auto": "Follows your language",
  "settings.calendar.changed": "Calendar updated.",
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
  "currency.title": "Choose currency",
  "currency.search": "Search by name, code or symbol",
  "currency.noMatch": "No matching currency.",
  "currency.precisionHint": "Kaata currently supports up to 2 decimal places for this currency.",
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
  "share.currencySettled": "🤝 {currency}: settled.",
  "share.billUnavailable": "The full bill could not be attached. These are the balances only.",
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
  "format.am": "AM",
  "format.pm": "PM",

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
  "common.ok": "OK",
  "menu.dev.bluetoothTest": "Bluetooth test (dev)",
  "common.back": "Back",
  "common.refreshFailed": "Couldn't refresh — check your connection.",
  "share.whatsappUnavailable": "Couldn't open WhatsApp. Is it installed on this phone?",
  "common.retry": "Retry",
  "common.done": "Done",
  "common.close": "Close",
  "common.hideKeyboard": "Hide keyboard",
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
  "person.ping.nudge": "Let {name} know on WhatsApp?",
  "person.ping.nudgeSend": "Send",
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
  "menu.account.signIn.choose": "Sign in",
  "menu.account.signIn.apple": "Sign in with Apple",
  "menu.account.signIn.email": "Sign in with email",
  "menu.account.signIn.toast": "Signed in",
  "menu.account.signIn.partialToast":
    "Signed in, but {count} kaata(s) couldn't be restored. Sign in again to retry.",
  "menu.account.signIn.failed": "Couldn't sign in — try again",
  "auth.error.recoveryUnavailable":
    "You're signed in, but your kaatas couldn't be restored. Check your connection and try again.",
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
  // Account → Sign-in (docs/kaata-accounts.md §7): how this account signs in.
  "account.signin.section": "Sign-in",
  "account.signin.email": "Email",
  "account.signin.loginEmail": "Password sign-in: {email}",
  "account.signin.password.set": "Set a password",
  "account.signin.password.setHint": "Also sign in with your email and a password",
  "account.signin.password.change": "Change password",
  "account.signin.password.remove": "Remove password",
  "account.signin.password.removeHint": "Sign in with Google or Apple only",
  "account.signin.username": "Username",
  "account.signin.username.none": "Not set",
  "account.signin.username.hint": "Use it instead of your email to sign in",
  "account.signin.loading": "Loading sign-in details…",
  "account.signin.failed": "Couldn't load sign-in details. Tap to try again.",
  "account.signin.network": "Couldn't reach Kaata. Check your connection and try again.",
  "account.signin.error": "That didn't work. Try again.",
  "accountPassword.title.set": "Set a password",
  "accountPassword.title.change": "Change password",
  "accountPassword.set.body":
    "Add a Kaata password to sign in with your email on any phone. First we'll send a code to the address.",
  "accountPassword.set.relayNote":
    "Your Apple account hides its email address, so enter one you can open.",
  "accountPassword.set.codeSent":
    "We sent a 6-digit code to {email}. Enter it with your new password.",
  "accountPassword.set.submit": "Save password",
  "accountPassword.set.done": "Password saved. You can now sign in with {email} and this password.",
  "accountPassword.change.current": "Current password",
  "accountPassword.change.body": "Other phones signed in to this account will be signed out.",
  "accountPassword.change.submit": "Change password",
  "accountPassword.change.done": "Password changed. Other phones were signed out.",
  "accountPassword.loadFailed": "Couldn't load your account. Check your connection and try again.",
  "accountPassword.set.fixedEmail": "We'll send a 6-digit code to {email}.",
  "accountPassword.remove.title": "Remove your password?",
  "accountPassword.remove.body":
    "You'll sign in with Google or Apple only. Phones signed in with the password are signed out.",
  "accountPassword.remove.cta": "Remove password",
  "accountPassword.remove.done": "Password removed",
  "accountUsername.title": "Username",
  "accountUsername.body":
    "A username works in place of your email when you sign in with your password. Only you see it.",
  "accountUsername.rules":
    "3 to 30 characters: lowercase letters, numbers, _ and ., starting with a letter.",
  "accountUsername.save": "Save username",
  "accountUsername.remove": "Remove username",
  "accountUsername.saved": "Username saved",
  "accountUsername.removed": "Username removed",
  "accountUsername.needsPassword": "Set a password first: a username only works with a password.",
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
  "menu.account.switch": "Switch account",
  "menu.account.localOnlyHint": "Sign in to enable backup + sync across phones.",
  // ABOUT section
  "menu.about": "About",
  "account.appHealth.section": "App health",
  "account.appHealth.details": "Detailed diagnostics",
  "account.appHealth.detailsHint": "Memory & crash info",
  "account.privacy.section": "Privacy & data",
  "account.privacy.label": "Privacy policy",
  "account.deleteAccount.label": "Delete account",
  "account.deleteAccount.hint": "30 days to recover by signing back in",
  "account.deleteAccount.confirm.title": "Delete your account?",
  "account.deleteAccount.confirm.body":
    "We will back up your saved tallies, sign you out and clear this phone. Your account and cloud data will be kept for 30 days, then permanently deleted. Sign back in within 30 days to cancel and restore saved cloud data you still have access to. Private reminders and Not sent drafts are only on this phone and will be lost, so note down any you need. Export statements of shared accounts you can no longer reach from the customer's page first. Previously purged data cannot return. Other participants keep shared tally history. Deletion does not settle a balance.",
  "account.deleteAccount.confirm.cta": "Delete account",
  "account.deleteAccount.preparing": "Saving a recovery copy…",
  "account.deleteAccount.backupFailed":
    "Deletion did not finish. Keep this phone's data, check your connection and finish syncing before trying again.",
  "account.deleteAccount.graceUnavailable":
    "Recovery protection is not available yet. Your account and this phone's data have been kept. Try again later.",
  "account.deleteAccount.recovered": "Deletion cancelled. Your cloud kaatas can be restored.",
  "account.deleteAccount.lateEdits":
    "New changes are safely kept on this phone. Sign in again with the same account to cancel deletion and back them up.",
  "account.deleteAccount.restoring": "Deletion cancelled. Restoring your kaatas…",
  "account.deleteAccount.failed":
    "Couldn't delete your account. Check your connection and try again.",
  "account.deleteAccount.authRequired":
    "Sign in again before deleting your account. Your local ledger has not been removed.",
  // Retired installation (HTTP 410, InstallRetiredError in lib/auth.ts): an
  // account this phone was signed in to has been deleted, so the server refuses
  // this install for sign-in and check-in. Shown by both sign-in error paths
  // and as a notice on Account; only the destructive confirmation erases.
  // Don't overstate it: the ledger keeps working offline and store updates
  // still arrive. Only signing in and backing up need the reset.
  "account.retired.title": "This phone's account was deleted",
  "account.retired.body":
    "The account this phone last signed in to was deleted. Your kaatas still work on this phone. If it was deleted less than 30 days ago, sign in with the same account to cancel the deletion and get everything back. Otherwise, to sign in or back up again, export anything you need first, then reset this phone, which erases everything Kaata keeps on it.",
  // While the account is inside its 30-day grace window (the server says so).
  "account.retired.pendingTitle": "Account deletion pending",
  "account.retired.pendingBody":
    "This phone's account will be deleted for good on {date}. Sign in with the same account before then to cancel the deletion and get everything back. Your kaatas still work on this phone meanwhile.",
  "account.retired.signInCancel": "Sign in to cancel deletion",
  "account.retired.reset": "Reset this phone",
  "account.retired.confirm.title": "Reset this phone?",
  "account.retired.confirm.body":
    "This erases everything Kaata keeps on this phone, including every kaata, person and tally. Export anything you need first. This cannot be undone.",
  "account.retired.confirm.cta": "Erase and reset",
  "account.retired.failed": "Couldn't reset this phone. Try again.",

  // Vault create (Phase 5.2 — Add a Kaata)
  // Outside onboarding, a Kaata can be for personal, household, or business use.
  "vaultNew.title": "Name your Kaata",
  // UX-fix #1: forced post-archive-last entry-point title. The back
  // chevron is hidden in this mode (no parent to pop to); the title
  // shifts to a directive framing so the screen reads as "you must
  // complete this".
  "vaultNew.titleForced": "Name your Kaata to continue",
  "vaultNew.name.label": "Kaata name",
  "vaultNew.name.placeholder": "e.g. Personal or Business",
  "vaultNew.name.required": "Name is required",
  "vaultNew.currency.label": "Default currency",
  "vaultNew.currency.hint":
    "Default currency for new tallies. Other currencies have separate balances in the same Kaata.",
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
    "1. Sign in to the same Kaata account.\n" +
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
    'The other phone must be signed in to the same Kaata account as this one. To invite someone else (a different account), use "Invite member" instead.',
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
  "vaultPairScan.error.signInRequired": "Sign in to the same account as the other phone first.",
  "vaultPairScan.error.accountMismatch":
    "This code was issued for a different account. Ask the owner to send you an email invitation instead.",
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
  "pairLink.signin.body": "Sign in to the SAME account as the other phone to complete pairing.",
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
    "This link was issued for a different account. Ask the owner to send you an email invitation instead.",

  // Vault settings — Phase 7 UX critique #8 (translated).
  "vaultSettings.title": "Kaata settings",
  "vaultSettings.role.owner": "Owner",
  "vaultSettings.role.manager": "Admin",
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
  // Own key rather than reusing entry.save/personEdit.save — shared keys
  // across unrelated screens is how a later reword on one surface silently
  // rewrites another (the personAdd.title lesson).
  "vaultSettings.name.save": "Save",
  "vaultSettings.currency.label": "Default currency",
  "vaultSettings.currency.hint":
    "Selected automatically for new tallies. Each saved tally keeps its own currency.",
  "vaultSettings.currencies.label": "Currencies for this Kaata",
  "vaultSettings.currencies.search": "Search currencies",
  "vaultSettings.currencies.limit":
    "You can enable up to 64 currencies. Turn one off to add another.",
  "vaultSettings.currencies.hint":
    "Choose currencies for new tallies. Tap a star to set the default. Existing tallies keep their currency.",
  "vaultSettings.currencies.default": "Default currency",
  "vaultSettings.currencies.defaultSummary": "Default: {currency}",
  "vaultSettings.currencies.selectedCount": "{count} selected",
  "vaultSettings.currencies.setDefault": "Set {currency} as default",
  "vaultSettings.currencies.changed":
    "Currency settings changed. Close and reopen this list to review the latest choices.",
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

  "ownershipTransfer.title": "Transfer ownership",
  "ownershipTransfer.intro":
    "Invite someone to take over this Kaata. You stay the owner until they accept, then keep access as an Editor. Update all phones that use this Kaata before transferring.",
  "ownershipTransfer.ownerOnly": "Only the owner can transfer this Kaata.",
  "ownershipTransfer.signedOut": "Sign in to create an ownership invitation.",
  "ownershipTransfer.offline": "Connect to the internet to manage this ownership invitation.",
  "ownershipTransfer.unavailable":
    "This Kaata must be active, fully synced and owned by your signed-in account before you can transfer it.",
  "ownershipTransfer.loadFailed":
    "Couldn't check ownership invitations. Try again before creating a link.",
  "ownershipTransfer.refresh": "Check status",
  "ownershipTransfer.recipient": "New owner",
  "ownershipTransfer.emailHint":
    "They must sign in with this email to accept. Forwarding the link to someone else won't give them ownership.",
  "ownershipTransfer.create": "Create ownership link",
  "ownershipTransfer.confirmTitle": "Invite a new owner?",
  "ownershipTransfer.confirmBody":
    "{email} will be able to accept ownership of this entire Kaata, including its members and shared ledgers. Until they accept, you remain the owner. After they accept, you'll stay as an Editor and only the new owner can transfer ownership back to you.",
  "ownershipTransfer.created": "Ownership invitation created",
  "ownershipTransfer.pending": "Waiting for acceptance",
  "ownershipTransfer.expires": "Expires {when}",
  "ownershipTransfer.pendingHint":
    "You are still the owner. The recipient becomes the owner only after signing in and accepting this invitation.",
  "ownershipTransfer.linkNotStored":
    "For privacy, the link is only available on the screen where it was created. To get a new link, cancel this invitation and create another.",
  "ownershipTransfer.shareEmail": "Send by email",
  "ownershipTransfer.shareMessage":
    "I'm inviting you to become the owner of {name} in Kaata. Sign in with your invited email and review the transfer here: {url}",
  "ownershipTransfer.emailSubject": "Ownership invitation for {name}",
  "ownershipTransfer.shareUnavailable":
    "Couldn't open the messaging app. You can copy the link instead.",
  "ownershipTransfer.cancel": "Cancel invitation",
  "ownershipTransfer.cancelTitle": "Cancel ownership invitation?",
  "ownershipTransfer.cancelBody":
    "The link will stop working. You will remain the owner and can invite someone else.",
  "ownershipTransfer.cancelled": "Ownership invitation cancelled",
  "ownershipTransfer.alreadyPending":
    "An ownership invitation is already pending. Check its status or cancel it before creating another.",
  "ownershipTransfer.selfTransfer": "Choose another person. You already own this Kaata.",
  "ownershipTransfer.failed":
    "Couldn't update the ownership invitation. Check your connection and try again.",
  "ownershipTransfer.existingMember": "Choose an existing member",
  "ownershipTransfer.existingMemberHint": "Transfer directly to someone already in this Kaata",

  // Vault members — Phase 7 UX critique #8 (translated).
  "members.title": "Members",
  "members.section.members": "Members ({count})",
  "members.section.pending": "Pending invites ({count})",
  "members.empty": "No members yet.",
  "members.nameUnavailable": "Name unavailable",
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
  "members.toast.transferSyncRequired":
    "This phone needs to finish syncing before transferring ownership. Connect to the internet, let this Kaata sync, then try again.",
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
  "members.sheet.makeManager": "Make admin",
  "members.rolesHelp":
    "Admins manage staff and credit limits. Only owners appoint admins, transfer ownership or archive this Kaata.",
  "members.credit.action": "Credit limit permissions",
  "members.credit.title": "Credit permissions · {name}",
  "members.credit.inherit": "Inherit role",
  "members.credit.inheritHint": "Use the customer's restriction for this member's role.",
  "members.credit.enforce": "Must obey hard limits",
  "members.credit.enforceHint":
    "Apply every hard limit, even when this member's role is exempt. Warn-only limits stay warnings.",
  "members.credit.bypass": "May exceed limits",
  "members.credit.bypassHint": "Let this member exceed hard limits. Credit warnings still appear.",
  "members.credit.onlineRequired": "Sign in and connect to change member permissions.",
  "members.credit.loadFailed":
    "Could not load current permissions. Check your connection and try again.",
  "members.credit.saveFailed":
    "Could not save the permission. Check your connection and try again.",
  "members.credit.memberNeedsSignIn":
    "Ask this member to sign in and sync, then change their credit permission.",
  "members.credit.saved": "Credit permission saved",
  "members.credit.working": "Checking credit permissions…",
  "members.appleHiddenEmail": "Apple account · email hidden",
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
  "invite.link.editorDisclosure":
    "Editors can add, edit and delete tallies in this Kaata. In shared accounts they can also accept or reject the other side's tallies (final) and unlink the account.",
  "invite.managerNote":
    "Owners can appoint admins to manage staff and credit limits. Invite the person first, then open Members, tap their name and choose Make admin.",
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
    "The invitee must accept with an account that uses this same email. Gmail addresses are matched without dots.",
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
  "ownershipAccept.title": "Ownership invitation",
  "ownershipAccept.heading": "Become the owner of {name}",
  "ownershipAccept.body":
    "{inviter} is offering you ownership of this Kaata. You will manage its members, settings and archiving. They will stay as an Editor. Sign in with the email they invited.",
  "ownershipAccept.accept": "Accept ownership",
  "ownershipAccept.done": "Ownership invitation accepted for {name}",
  "ownershipAccept.unavailable":
    "This ownership invitation is expired, cancelled or unavailable for your account. Sign in with the email the owner invited, or ask them for a new link.",
  "inviteAccept.invalidLink": "Invalid invitation link",
  "inviteAccept.signin.body":
    "Sign in to accept this invitation, with an account that uses the email address that received it.",
  "inviteAccept.signin.cta": "Sign in",
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
  "inviteAccept.pending.title": "Finishing your connection",
  "inviteAccept.pending.body":
    "Your invitation was accepted. Keep Kaata online to finish setup. We’ll retry automatically.",
  "inviteAccept.blocked.title": "Setup needs help",
  "inviteAccept.blocked.body": "Setup could not finish. Ask the kaata owner for help.",
  "inviteAccept.error.title": "Something went wrong",
  "inviteAccept.error.notVisible":
    "This invitation isn't visible on your account. The invite is anchored to a specific email — try signing in with the account that uses the email that received it.",
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
  // Android lands the file in the public Downloads folder without asking, so
  // the confirmation has to say WHERE; on iOS the user just chose the place.
  "export.savedDownloads": "Saved to Downloads as {name}",
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
  // PDF document furniture. Section titles read as headings, not labels, so
  // they carry no colon.
  "export.doc.customer": "Customer",
  "export.doc.preparedBy": "Prepared by",
  "export.doc.summarySection": "Account summary",
  "export.doc.transactionsSection": "Transactions",
  "export.doc.peopleSection": "People",
  "export.doc.totalGave": "Total gave",
  "export.doc.totalReceived": "Total received",
  // The full-width rule-off row in a PDF. Deliberately NOT the UI chip
  // (person.history.settledOn, "Settled · {date}"): in Dari that middle dot
  // lands against the leading digit of the date and reads as a Persian zero,
  // turning "۱۳ سنبله" into "۱۳۰ سنبله". A document spells the word out.
  "export.doc.settledOn": "Settled on {date}",
  // Its shared counterpart, a clearance marker on a mutual tab: same rule,
  // never the UI chip (tab.settle.history). lib/export/note.ts builds both
  // sentences; the PDF isolates the name and the date. An empty name is normal
  // (Apple can withhold it) and takes the second sentence.
  "export.doc.clearedBy": "Cleared by {name} on {date}",
  "export.doc.clearedUnnamed": "Cleared on {date} (name not recorded)",
  "export.col.date": "Date",
  "export.col.dateShamsi": "Date (Shamsi)",
  "export.col.dateQamari": "Date (Qamari)",
  "export.col.person": "Name",
  "export.col.phone": "Phone",
  "export.col.note": "Note",
  "export.col.gave": "Gave",
  "export.col.received": "Received",
  "export.col.balance": "Balance",
  "export.col.entries": "Entries",
  "export.col.num": "#",
  "export.col.amount": "Amount",
  "export.col.type": "Type",
  "export.col.status": "Status",
  "export.col.lastActivity": "Last activity",
  "export.col.id": "Entry ID",
  "export.record.title": "Shared record with recorded acknowledgements",
  "export.record.explanation":
    "The balance counts confirmed shared tallies and private entries separately identified here. Pending net changes exclude acknowledged amounts already carried into a proposed opening. Pending amounts are not acknowledged debt. Rejected and cancelled tallies contribute zero. Missing reviewer details were not recorded. Names are account labels, not verified legal identities.",
  "export.record.acknowledgedBalance": "Acknowledged net balance",
  "export.record.pendingBalance": "Pending net balance",
  "export.record.privateBalance": "Private net balance",
  "export.record.contribution": "Balance contribution",
  "export.record.status": "Record status",
  "export.record.pending": "Pending",
  "export.record.accepted": "Accepted",
  "export.record.rejected": "Rejected",
  "export.record.cancelled": "Cancelled",
  "export.record.private": "Private tally",
  "export.record.sync": "Sync state",
  "export.record.awaitingSync": "Awaiting sync",
  "export.record.acceptanceAwaitingSync": "Acceptance awaiting sync",
  "export.record.rejectionAwaitingSync": "Rejection awaiting sync",
  "export.record.cancellationAwaitingSync": "Cancellation awaiting sync",
  "export.record.saved": "Recorded on server",
  "export.record.tabId": "Shared account ID",
  "export.record.author": "Added by",
  "export.record.authorId": "Author account reference",
  "export.record.authorRole": "Author role at the time",
  "export.record.recordedAt": "Recorded at (UTC)",
  "export.record.reviewer": "Reviewed by",
  "export.record.reviewerId": "Reviewer account reference",
  "export.record.reviewerParty": "Reviewer side",
  "export.record.reviewerRole": "Reviewer role at the time",
  "export.record.reviewedAt": "Reviewed at (UTC)",
  "export.record.reviewVersion": "Review action version",
  "export.record.reason": "Rejection reason",
  "export.record.cancelledBy": "Cancelled by",
  "export.record.cancelledById": "Cancelling account reference",
  "export.record.cancelledAt": "Cancelled at (UTC)",
  "export.record.cancellationId": "Cancellation record ID",
  "export.record.seq": "Record sequence",
  "export.record.rev": "Record revision",
  "export.record.unknown": "Not recorded",
  "export.record.closedDeleted":
    "Closed because an account was deleted. The shared record is read-only.",
  "export.record.archiveTitle": "Earlier shared period",
  "export.preLinkHistory.title": "Private history before linking",
  "export.preLinkHistory.note":
    "Historical records only. Their balance is already carried by the opening tally and is excluded from the current total.",
  "export.record.beforeLink": "Before linking — excluded from current balance",
  "export.record.archiveExplanation":
    "Historical evidence only. This period is excluded from the current balance; its carried-over amount is represented by a later opening tally. The period balance below belongs to this earlier account.",
  "export.record.scope": "Balance scope",
  "export.record.current": "Current statement",
  "export.record.archived": "Earlier shared period — excluded from current balance",
  "export.record.currency": "Currency",
  "export.record.periodBalance": "Earlier period balance",
  // CSV: a shared-shape row's amount as recorded, signed like Balance
  // contribution. Gave/Received carry only what counts (lib/export/csv.ts).
  "export.record.recordedAmount": "Recorded amount",
  // PDF evidence values; the CSV keeps the machine values. Roles otherwise
  // reuse vaultSettings.role.*; "account" is the server's word for the party's
  // own account acting directly rather than as a kaata member.
  "export.record.role.account": "Account holder",
  // The reviewer's party relative to whoever exported the statement: the
  // wire's a/b letters mean nothing on paper.
  "export.record.side.this": "This side",
  "export.record.side.other": "Other side",

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
  // --- App health / diagnostics (app/diagnostics.tsx) ---
  // This screen was 100% hardcoded English until 1.0.8 — the one screen a Dari
  // shopkeeper is sent to WHEN SOMETHING IS ALREADY BROKEN, i.e. the moment
  // they can least cope with a language switch. The report BODY stays English
  // on purpose: it is diagnostic data we read, not prose they read.
  "diagnostics.title": "App health",
  "diagnostics.hint":
    "Something not working? Tap Send to support — WhatsApp opens with this report already written, so we can see what’s happening and fix it. Or copy it and send it yourself.",
  "diagnostics.copyReport": "Copy report",
  "diagnostics.copying": "Copying…",
  "diagnostics.copied": "Copied ✓",
  "diagnostics.sendToSupport": "Send to support",
  // The first line of the WhatsApp message, above the report. It exists so
  // the chat opens with something a PERSON would send rather than a wall of
  // diagnostics — and so the share-sheet fallback (user picks the recipient)
  // still reads as a message rather than a paste.
  "diagnostics.support.intro":
    "Hi Kaata — something isn’t working in the app. Here is my app health report.",
  "diagnostics.toast.copied": "Copied — now send it to us on WhatsApp",
  "diagnostics.toast.copyFailed": "Couldn’t auto-copy — copy the text below",
  "diagnostics.toast.sendFailed": "Couldn’t open WhatsApp — copy the report and send it to us",
  "diagnostics.fallbackHint": "Long-press the text below → Select all → Copy, then send it to us.",
  "diagnostics.section.version": "VERSION",
  "diagnostics.staleBuild":
    "⚠ bundled JS {js} ≠ native {native} — running a stale build; reinstall the latest APK.",
  "diagnostics.section.exits": "WHY THE APP DIED (most recent first)",
  "diagnostics.noExits": "No exit records (Android < 11, or fresh install with no prior death).",
  "diagnostics.section.now": "RIGHT NOW",
  "diagnostics.refresh": "Refresh",

  // Mutual tab (Kaata 2.0, docs/mutual-tab-design.md §4.4). The user-facing
  // noun is "shared account" — a shopkeeper thinks "Ahmad's account", never
  // "a tab" (D3). "Link" is the verb for creating one and the noun for the
  // invite URL; both senses are deliberate, because the URL IS the other
  // party's access (D11). Status words are calm on purpose: a tally counts
  // the moment it lands (D6), so nothing here nags for an acknowledgement.
  "tab.link.title": "Link with their kaata",
  "tab.link.action": "Create shared account",
  "tab.link.confirm.title": "Share this account?",
  "tab.link.confirm.body":
    "{name} will see every tally on this account and can add, accept or reject tallies. Rejected tallies stay visible but do not count toward the balance. The current balance is carried over as one visible opening tally.",
  "tab.link.confirm.ok": "Link",
  "tab.link.whatsapp": "Link and open WhatsApp",
  "tab.link.ready": "Invitation ready",
  "tab.link.readyBody": "Send this invitation to {name} so they can join from their Kaata app.",
  "tab.link.inviteUnavailable":
    "This account is already linked. Only the side that created it can share its invitation.",
  "tab.link.failed": "Couldn't link. Check your connection and try again.",
  "tab.link.sent": "Link sent",
  // Note on the D7 opening entry; the other party reads it in THEIR list.
  "tab.opening.note": "Balance before linking",
  "tab.share.whatsapp": "Send link on WhatsApp",
  "tab.share.copy": "Copy link",
  "tab.copied": "Link copied",
  "tab.share.again": "Send link again",
  "tab.regenerate": "New link (old one stops working)",
  "tab.regenerate.title": "Make a new link?",
  "tab.regenerate.body":
    "The link you sent before stops working for everyone who has it. Send the new one to {name}.",
  "tab.regenerate.ok": "New link",
  "tab.unlink": "Unlink",
  "tab.unlink.title": "Unlink {name}?",
  // Unlinking stops new sharing after the server acknowledges it. Existing
  // evidence and the right to resolve pending tallies remain.
  "tab.unlink.body":
    "After syncing, neither side can add new shared tallies or send alerts through this account. Accepted records and the confirmed balance stay saved. Pending tallies can still be reviewed or cancelled under the same rules. New tallies in your own book are private.",
  "tab.unlink.pending": "Unlinking is waiting to sync. Connect to stop sharing on both phones.",
  "tab.history.pending":
    "Review and sync the pending tallies from the previous shared period before linking again.",
  "tab.history.changed":
    "The shared history changed. Refresh it and check the opening balance before linking again.",
  "tab.history.openingRequired":
    "This contact still has a confirmed shared balance. Linking again needs an opening balance the other party can review.",
  "tab.balance.confirmed": "Confirmed shared balance: {amount} {currency}",
  "tab.balance.pending": "{count} pending · net change {amount} {currency}",
  "tab.unlinked": "Unlinked",
  "tab.chip.linked": "Linked · {name}",
  "tab.chip.waiting": "Link sent · waiting",
  // Fold row over the pre-link local rows (D8: visible, excluded from the balance).
  "tab.beforeLinking": "Before linking · {count}",
  "tab.notSent": "Not sent · {count}",
  "tab.notSent.body":
    "These tallies could not be added to the shared account. They are kept on this phone for you to review and are not included in the balance.",
  // Row pills (≤ 20 px, monochrome). Accepted rows show nothing.
  "tab.status.new": "New",
  "auth.redirect.title": "Sign in to continue",
  "auth.redirect.subtitle":
    "Use your Kaata account. Your existing kaatas will be restored automatically.",
  "tab.status.accepted": "Accepted",
  "tab.feedback.accepted": "Tally ({amount}) accepted.",
  "tab.feedback.rejected": "Tally ({amount}) rejected. Excluded from the balance.",
  "tab.feedback.manyAccepted": "{count} tallies accepted.",
  "tab.feedback.manyRejected": "{count} tallies rejected. Excluded from the balance.",
  "tab.feedback.mixed": "{accepted} accepted, {rejected} rejected. Rejected tallies don't count.",
  "tab.status.pending": "Pending",
  "tab.status.disputed": "Rejected",
  "tab.status.voided": "Voided",
  "tab.status.sending": "Sending…",
  // Opened-row words. A tab counterparty is not a kaata member, so these
  // replace entry.addedBy rather than feeding the attribution chip.
  "tab.addedBy": "Added by {name}",
  "tab.addedByYou": "Added by you",
  "tab.disputedReason": "Rejected: {reason}",
  "tab.void": "Void",
  "tab.cancel": "Cancel tally",
  "tab.void.title": "Void this tally?",
  "tab.void.body":
    "It stays visible, struck through, and no longer counts. Add a new tally if the amount was wrong.",
  "tab.voided": "Tally voided",
  "tab.accept": "Accept",
  "tab.accepted": "Accepted",
  "tab.rejectedHint": "Not included in the balance.",
  "tab.reviewFinal": "This tally has already been reviewed. Send a new tally to try again.",
  "tab.reject": "Reject",
  "tab.dispute": "Add a reason…",
  "tab.dispute.title": "Rejection · {amount}",
  "tab.dispute.reasonLabel": "What is wrong?",
  "tab.dispute.reasonPlaceholder": "e.g. I paid 300, not 500",
  "tab.dispute.reasonRequired": "Write a reason so {name} understands.",
  "tab.dispute.reasonTooLong": "Keep it under 300 characters.",
  "tab.dispute.send": "Reject tally",
  "tab.dispute.notFound": "This tally is no longer on the shared account.",
  "tab.disputed": "Rejected — removed from the balance",
  "tab.closed": "This shared account was closed.",
  "tab.closedNote":
    "Sharing stopped on {date}. Confirmed records stay saved and pending tallies can still be reviewed. New tallies here are private.",
  "tab.settle.confirm":
    "The reviewed balance with {name} is zero. Move these tallies into shared history for both of you and start a fresh page? The records stay saved, and you can keep using this shared account.",
  "tab.settle.pending": "Review and sync all pending tallies before clearing this account.",
  "tab.settle.changed": "The shared history changed. Review it, then try clearing again.",
  "tab.settle.failed":
    "Could not clear this shared account. Connect to the internet and try again.",
  "tab.settle.history": "Cleared by {name} · {date}",
  "tab.reviewedBy": "Reviewed by {name}",
  "tab.cancelledBy": "Cancelled by {name}",
  "tab.needsConnection": "Go online to add to a shared account.",
  "tab.editLocked":
    "Shared tallies cannot be edited. You can cancel your own pending tally; corrections to accepted tallies need a new record.",
  "tab.currencyLocked": "Unlink shared accounts before changing the currency.",
  // D17 settlement double-log warning, toasted after the save lands.
  "tab.duplicateHint": "Already recorded by {name} — check it isn't counted twice.",
  // Fallback for {name} when the other party has not joined (no label yet).
  // A NOUN PHRASE, not a pronoun: every template that takes it reads "Added
  // by {name}" / "so {name} understands", and "they" turns both ungrammatical.
  "tab.them": "the other side",
  "tab.row.pending": "{count} to review",
  "tab.row.awaiting": "{count} awaiting confirmation",
  "tab.row.notDownloaded": "Shared account not downloaded yet",
  "tab.notDownloaded":
    "This shared account hasn't downloaded to this phone yet. Its balance appears once it does; check your connection if this stays.",
  // Outgoing WhatsApp invite. The URL sits on its own line, exactly like
  // share.fullLedger's link: nothing (not even an invisible bidi mark) may
  // touch it, or some clients stop recognising it as a link.
  "tab.invite.message":
    "{name} shares a Kaata account with you. Open the link to see the balance and add or confirm tallies:\n{url}",

  // Joining someone else's shared account (app/t/[token].tsx, D10/D11). The
  // visitor here may never have signed in and may not even have a kaata yet,
  // so the copy explains the invitation before it asks for anything. Currency
  // codes are Latin tokens inside Dari prose and are bidi-isolated at the call
  // site, never here.
  "tab.join.title": "Shared account",
  "tab.join.from": "{name} shares an account with you",
  "tab.join.balanceLabel": "Balance",
  "tab.join.entries": "{count} tallies",
  "tab.join.join": "Join",
  "tab.join.pickKaata": "Which kaata is this for?",
  "tab.join.pickContact": "Who is {name} in your kaata?",
  "tab.join.newContact": "New contact",
  // D9: the tab's currency is fixed at creation and a kaata cannot change its
  // currency while it holds an OPEN tab. When no kaata matches, the screen
  // offers to switch one (lib/tabs/join-plan.ts planCurrency) or to create a
  // new kaata preset to the tab's currency — never a dead end.
  "tab.join.noCurrencyKaata": "You need a kaata in {currency} for this account.",
  "tab.join.createKaata": "Create a {currency} kaata",
  "tab.join.done": "Linked with {name}",
  "tab.join.closed": "This shared account was closed.",
  // Collapses unknown / regenerated / revoked — the server answers all three
  // with the same 404 by design (uniform 404).
  "tab.join.notFound": "This link is not valid any more.",
  "tab.join.currencyMismatch": "Your kaata is in {kaata}; this account is in {tab}.",
  "tab.join.sameKaata": "You can't share an account with your own kaata.",
  "tab.join.sameAccount":
    "You are already on the other side of this shared account (it is your kaata, or you are a member of it). Join with a different account.",
  "tab.join.alreadyLinked": "This contact already has a shared account.",
  // TabCurrencyMismatchError.serverStale: the kaata already matches locally,
  // only the server's copy of its currency is behind (event not pushed yet).
  "tab.join.currencyNotSynced":
    "Your kaata's currency change hasn't reached the server yet. Check your connection and try again.",
  // Currency plan (both codes are bidi-isolated by the caller).
  "tab.join.currencyIntro": "Your kaata is in {kaata}. This shared account is in {tab}.",
  "tab.join.switchCurrency": "Use {name} in {currency}",
  "tab.join.switchEmptyHint": "No tallies yet, so nothing changes.",
  "tab.join.switchRelabelHint": "Existing amounts will be shown in {currency}, not converted.",
  "tab.join.lockedByTab": "Locked to {currency} by a shared account",
  "tab.join.lockedByRole": "Only an owner or admin can change this kaata's currency",
  "tab.join.createSeparate": "Create a separate {currency} kaata",
  // Heading over the secondary switch rows. It names the VERB: a row under
  // "choose another kaata" read as a picker, and one tap relabelled every
  // tally of a full book. Rows with tallies confirm first (switchConfirmTitle).
  "tab.join.orPick": "Or switch a kaata to {currency}",
  "tab.join.switchConfirmTitle": "Switch {name} to {currency}?",
  // Hint under the currency row of vault/new + onboarding/kaata when a pending
  // invitation preset it.
  "tab.join.currencyPreset":
    "This shared account uses {currency}. The kaata is created in that currency.",
  // Contact suggestion (suggestJoinContact): who the invitation's number is.
  "tab.join.suggestTitle": "Matches the number this invitation came from",
  "tab.join.suggestFromPhone": "From your phone contacts",
  "tab.join.suggestFromInvite": "From the invitation",
  // suggestWillCreate only when the person is NOT in the phone book yet AND
  // contacts access is granted (createPerson's phone-book write is silent
  // otherwise); suggestWillAdd everywhere else a person is created.
  "tab.join.suggestWillCreate": "Added to your kaata and phone contacts",
  "tab.join.suggestWillAdd": "Added to your kaata",
  "tab.join.linkTo": "Will be linked to",
  "tab.join.chooseElse": "Choose someone else",
  // The object is the CONTACT the account links to, never an identity: "Join
  // as Matee" read as joining under the other party's name.
  "tab.join.joinAs": "Link with {name}",
  "tab.join.searchContacts": "Search contacts",
  "tab.join.inKaata": "In your kaata",
  "tab.join.switched": "{name} now uses {currency}",

  // Local notifications (lib/tabs/notify.ts, D14). The channel strings are read
  // by the OS settings list, so they name the feature the way the app does.
  "tab.notify.channel": "Shared accounts",
  "tab.notify.channelDescription":
    "Tallies the other party added or reviewed while Kaata was in the background.",
  "tab.notify.fallbackTitle": "Shared account",
  "tab.notify.newEntries": "{count} new tallies to review",
  "tab.notify.reviewed": "Your tallies were reviewed",
  "tab.notify.accepted": "Your tally was accepted.",
  "tab.notify.rejected": "Your tally was rejected and no longer counts toward the balance.",
  "tab.notify.voided": "A tally on your shared account was voided.",
  "tab.notify.actionFailed": "Couldn’t send your response. Open Kaata to review this tally.",
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
  "selection.start": "انتخاب",
  "selection.contacts": "انتخاب مخاطبین",
  "selection.tallies": "انتخاب ثبت‌ها",
  "selection.count": "{count} انتخاب شده",
  "selection.all": "انتخاب همه",
  "selection.clear": "لغو انتخاب همه",
  "selection.allResults": "انتخاب همه نتایج",
  "selection.clearResults": "لغو انتخاب نتایج",
  "selection.close": "تمام",
  "selection.hint": "برای انتخاب یا لغو انتخاب این مورد، دو بار ضربه بزنید.",
  "selection.removeContactsTitle": "{count} مخاطب برداشته شود؟",
  "selection.removeContactsDescription":
    "این مخاطبین در این کاتا پنهان می‌شوند. می‌توانید آن‌ها را از بخش اشخاص حذف‌شده برگردانید.",
  "selection.contactsRemoved": "{count} مخاطب برداشته شد",
  "selection.deleteTalliesTitle": "{count} ثبت حذف شود؟",
  "selection.deleteTalliesDescription":
    "این ثبت‌ها حذف می‌شوند و بیلانس‌ها تغییر می‌کنند. این کار قابل برگشت نیست.",
  "selection.talliesDeleted": "{count} ثبت حذف شد",
  "selection.partialFailure": "{count} مورد به‌روز نشد. دوباره کوشش کنید.",
  "selection.remove": "برداشتن",
  "selection.delete": "حذف",
  "selection.empty": "برای انتخاب موارد، روی آن‌ها ضربه بزنید",
  "selection.summary.transactions": "{count} معامله",
  "selection.summary.transaction": "{count} معامله",
  "selection.summary.transactionsLabel": "معاملات",
  "selection.summary.debt": "مجموع طلب",
  "selection.summary.credit": "مجموع قرض",
  "selection.summary.remaining": "باقی‌مانده حساب",
  "selection.summary.collect": "طلب باقی‌مانده",
  "selection.summary.pay": "قرض باقی‌مانده",
  "selection.summary.unavailable": "اطلاعات بعضی حساب‌های انتخاب‌شده در این تیلفون موجود نیست.",
  "inbox.title": "اعلان‌ها",
  "inbox.bell": "اعلان‌ها، {count} ناخوانده",
  "inbox.unread": "ناخوانده",
  "inbox.markAll": "همه خوانده شد",
  "inbox.seeAll": "دیدن همهٔ اعلان‌ها",
  "inbox.empty": "اعلان تازه‌ای ندارید. تغییرات حساب مشترک اینجا می‌آید.",
  "inbox.unavailable": "برای دیدن اعلان‌ها به اینترنت وصل شوید.",
  "inbox.signIn": "برای دیدن اعلان‌های حساب مشترک وارد شوید.",
  "inbox.failed": "اعلان‌ها به‌روز نشد.",
  "inbox.retry": "برای تلاش دوباره بزنید.",
  "inbox.openFailed": "حساب باز نشد. اتصال و دسترسی خود را بررسی کنید.",
  "tab.notify.detail.new": "{name} یک ثبت {amount} افزود. قبول یا رد کنید.",
  "tab.notify.detail.accepted": "ثبت {amount} شما توسط {name} قبول شد.",
  "tab.notify.detail.rejected": "ثبت {amount} شما توسط {name} رد شد؛ در مانده حساب نمی‌شود.",
  "tab.notify.detail.voided": "ثبت {amount} توسط {name} لغو شد.",
  // Onboarding
  "onboarding.subtitle": "یک دفتر شخصی میان شما و کسانی که اعتماد دارید.",
  "onboarding.name.label": "نام شما",
  "onboarding.name.placeholder": "سلطان",
  "onboarding.lastName.label": "تخلص",
  "onboarding.lastName.placeholder": "احمدی",
  "onboarding.phone.label": "شماره تلفون",
  "onboarding.phone.required": "شماره تلفون لازم است",
  "onboarding.phone.hint": "کمک می‌کند همکاران‌تان هنگام وصل کردن تلفون‌ها شما را پیدا کنند.",
  "onboarding.continue": "ادامه",
  "onboarding.nameRequired": "نام لازم است",
  "recovery.selfPlaceholderName": "شما",

  // Onboarding step 1 — language picker
  "onboardingLanguage.title": "زبان خود را انتخاب کنید",
  "onboardingLanguage.subtitle":
    "زبانی را که راحت‌تر هستید انتخاب کنید. بعداً در بخش حساب قابل تغییر است.",

  // Onboarding mode picker
  "onboardingMode.title": "با کاتا شروع کنید",
  "onboardingMode.subtitle": "روش نگهداری حساب‌های‌تان را انتخاب کنید.",
  "onboardingMode.account.label": "با حساب",
  "onboardingMode.account.body":
    "از کاتاهای‌تان نسخهٔ پشتیبان بگیرید، روی تلفون نو برگردانید و در چند تلفون استفاده کنید.",
  "onboardingMode.google.title": "ورود با گوگل",
  "onboardingMode.apple.title": "ورود با اپل",
  "onboardingMode.offline.label": "حالت نینجا",
  "onboardingMode.offline.body":
    "در سایه بمانید. نیازی به حساب نیست. کاتای‌تان را روی همین تلفون نگه دارید و برای پشتیبان‌گیری ابری، بعداً وارد حساب شوید.",
  "onboardingMode.offline.title": "ادامه در حالت نینجا",
  "onboardingMode.offline.warning":
    "در حالت نینجا از اطلاعات‌تان در حساب نسخهٔ پشتیبان گرفته نمی‌شود. اگر این تلفون را گم کنید، ممکن است همهٔ اطلاعات‌تان را از دست بدهید. برای پشتیبان‌گیری، بعداً وارد حساب شوید.",
  "onboardingMode.signInFailed": "ورود نشد. دوباره امتحان کنید.",
  "onboardingMode.signInFailed.network":
    "ورود به کاتا نرسید. انترنت را بررسی کنید و دوباره امتحان کنید.",
  "onboardingMode.signInFailed.playServices":
    "این تلفون به نسخهٔ جدیدتر Google Play Services ضرورت دارد. آن را از Play Store به‌روز کنید یا بدون حساب ادامه دهید.",
  "onboardingMode.expoGoHint":
    "ورود در نسخه واقعی برنامه کار می‌کند؛ فعلاً می‌توانید در حالت نینجا ادامه دهید.",
  "onboardingMode.back": "برگشت",
  // Kaata accounts: email + password. Matee: please proofread.
  "onboardingMode.email.title": "ادامه با ایمیل",
  "auth.email.signIn.title": "ورود با ایمیل",
  "auth.email.signIn.subtitle": "ایمیل یا نام کاربری و رمز حساب کاتای خود را بنویسید.",
  "auth.email.identifier": "ایمیل یا نام کاربری",
  "auth.email.password": "رمز",
  "auth.email.signIn.submit": "ورود",
  "auth.email.forgot": "رمز را فراموش کرده‌اید؟",
  "auth.email.toSignUp": "ساختن حساب",
  "auth.email.toSignIn": "حساب دارید؟ وارد شوید",
  "auth.email.signUp.title": "ساختن حساب کاتا",
  "auth.email.signUp.subtitle": "یک کود 6 رقمی به ایمیل شما می‌فرستیم تا آدرس تأیید شود.",
  "auth.email.email": "ایمیل",
  "auth.email.newPassword": "رمز کاتا",
  "auth.email.newPassword.helper": "برای کاتا یک رمز نو بسازید، نه رمز جیمیل خود را",
  "auth.email.sendCode": "فرستادن کود",
  "auth.email.gmail": "ادامه با گوگل: به رمز نیاز نیست",
  "auth.email.providerHint": "با گوگل یا اپل حساب ساخته‌اید؟ از همان دکمه استفاده کنید.",
  "auth.email.code.title": "ایمیل خود را ببینید",
  "auth.email.code.sent":
    "یک کود 6 رقمی به {email} فرستادیم. اگر این آدرس از قبل حساب کاتا داشته باشد، در ایمیل نوشته شده که چطور وارد شوید.",
  "auth.email.code.label": "کود 6 رقمی",
  "auth.email.code.spam": "پس از یک دقیقه نرسید؟ پوشهٔ Spam (هرزنامه) را ببینید.",
  "auth.email.code.resend": "فرستادن کود نو",
  "auth.email.code.resendIn": "فرستادن کود نو پس از {time}",
  "auth.email.code.resent": "کود نو در راه است.",
  "auth.email.code.changeEmail": "تغییر ایمیل",
  "auth.email.code.passwordAgain": "رمز کاتا را که انتخاب کردید، دوباره بنویسید.",
  "auth.email.code.submit": "ساختن حساب",
  "auth.email.forgot.title": "بازیابی رمز",
  "auth.email.forgot.subtitle":
    "ایمیلی را بنویسید که با آن وارد می‌شوید. اگر رمز کاتا داشته باشد، یک کود برای گذاشتن رمز نو می‌فرستیم.",
  "auth.email.backToSignIn": "برگشت به ورود",
  "auth.email.reset.title": "رمز نو بگذارید",
  "auth.email.reset.sent":
    "اگر {email} رمز کاتا داشته باشد، یک کود 6 رقمی به آن فرستادیم. کود و یک رمز نو را بنویسید.",
  "auth.email.reset.newPassword": "رمز نو",
  "auth.email.reset.submit": "ذخیره و ورود",
  "auth.email.required": "ایمیل خود را بنویسید.",
  "auth.email.identifierRequired": "ایمیل یا نام کاربری خود را بنویسید.",
  "auth.email.passwordRequired": "رمز خود را بنویسید.",
  "auth.email.codeRequired": "کود 6 رقمی ایمیل را بنویسید.",
  "auth.password.show": "نشان دادن رمز",
  "auth.password.hide": "پنهان کردن رمز",
  "auth.password.rule.length": "دست‌کم 8 حرف، عدد یا نشانه",
  "auth.password.rule.digits": "اگر رمز تنها عدد است، دست‌کم 12 رقم باشد",
  "auth.password.rule.runs": "بدون ترتیب‌های ساده مانند 123456 یا aaaaaa",
  "auth.password.rule.personal": "رمز معمول یا ایمیل شما نباشد",
  "auth.error.email.format": "یک آدرس ایمیل درست بنویسید، مانند \u2066name@example.com\u2069.",
  "auth.error.email.relay": "آدرس پنهان اپل این‌جا کار نمی‌کند. آدرس ایمیل خود را بنویسید.",
  "auth.error.email.disposable":
    "آدرس‌های ایمیل موقت پذیرفته نمی‌شوند. آدرسی را بنویسید که نگه می‌دارید.",
  "auth.error.email.required": "یک آدرس ایمیل برای ورود بنویسید.",
  "auth.error.email.inUse": "یک حساب دیگر کاتا این ایمیل را دارد. آدرس دیگری بنویسید.",
  "auth.error.password.too_short": "دست‌کم 8 حرف، عدد یا نشانه بنویسید.",
  "auth.error.password.too_long": "رمز نباید بیشتر از 128 حرف، عدد یا نشانه داشته باشد.",
  "auth.error.password.whitespace": "فاصلهٔ اول یا آخر رمز را بردارید.",
  "auth.error.password.common": "این رمز بسیار معمول است. رمزی بگذارید که حدس زدنش سخت‌تر باشد.",
  "auth.error.password.personal": "ایمیل، نام کاربری یا شمارهٔ تلفون خود را در رمز نگذارید.",
  "auth.error.password.pattern":
    "از ترتیب‌های ساده مانند 123456، aaaaaa یا تنها عدد استفاده نکنید.",
  "auth.error.password.weak": "رمز قوی‌تری بگذارید.",
  "auth.error.code.invalid":
    "این کود درست نیست یا وقتش گذشته است. از تازه‌ترین ایمیل استفاده کنید یا کود نو بفرستید.",
  "auth.error.accountExists": "برای این ایمیل از قبل حساب کاتا هست. به جایش وارد شوید.",
  "auth.error.invalidCredentials": "ایمیل، نام کاربری یا رمز درست نیست.",
  "auth.error.wrongPassword": "رمز فعلی شما درست نیست.",
  "auth.error.noPassword": "این حساب هنوز رمز کاتا ندارد.",
  "auth.error.passwordExists": "این حساب از قبل رمز کاتا دارد.",
  "auth.error.username.format":
    "3 تا 30 حرف، عدد یا نشانه؛ فقط حرف‌های کوچک انگلیسی، عدد، _ و .؛ با یک حرف شروع شود.",
  "auth.error.username.reserved": "این نام کاربری در دسترس نیست. نام دیگری انتخاب کنید.",
  "auth.error.username.taken": "این نام کاربری گرفته شده است. نام دیگری انتخاب کنید.",
  "auth.error.name.invalid": "نام شما باید 2 تا 60 حرف، عدد یا نشانه داشته باشد.",
  "auth.error.name.provider": "نام شما از گوگل یا اپل می‌آید.",
  "auth.error.tooManyAttempts": "تلاش‌ها زیاد شد. چند دقیقه صبر کنید و دوباره امتحان کنید.",
  "auth.error.tooManyAttempts.wait": "تلاش‌ها زیاد شد. پس از {time} دوباره امتحان کنید.",
  "auth.error.tooManyEmails":
    "درخواست‌ها برای این ایمیل زیاد شد. کمی صبر کنید و دوباره امتحان کنید.",
  "auth.error.tooManyEmails.wait":
    "درخواست‌ها برای این ایمیل زیاد شد. پس از {time} دوباره امتحان کنید.",
  "auth.error.rateLimited": "تلاش‌ها زیاد شد. چند دقیقه صبر کنید و دوباره امتحان کنید.",
  "auth.error.rateLimited.wait": "تلاش‌ها زیاد شد. پس از {time} دوباره امتحان کنید.",
  "auth.error.emailUnavailable":
    "فعلاً کود ایمیل فرستاده نمی‌شود. با گوگل یا اپل وارد شوید یا بعداً دوباره امتحان کنید.",
  "auth.error.busy": "کاتا مصروف است. کمی بعد دوباره امتحان کنید.",
  "auth.error.accountDisabled": "این حساب غیرفعال شده است.",
  "auth.error.accountDeletionExpired":
    "مهلت ۳۰ روزهٔ بازگردانی پایان یافته است. این حساب برای همیشه حذف می‌شود.",
  "auth.error.sessionExpired": "از حساب بیرون شده‌اید. دوباره وارد شوید و باز امتحان کنید.",
  // Final-review strings (2026-10-10). Matee: please proofread.
  "auth.error.emailFixed": "برای گذاشتن رمز، از آدرس ایمیل همین حساب استفاده کنید.",
  "auth.error.providerSessionRequired": "برای حذف رمز، با گوگل یا اپل وارد شوید.",
  "auth.error.tokenExpired": "ورود زیاد طول کشید. لطفاً دوباره وارد شوید.",
  "auth.wait.seconds": "{n} ثانیه",
  "auth.wait.minute": "1 دقیقه",
  "auth.wait.minutes": "{n} دقیقه",
  "auth.wait.hour": "1 ساعت",
  "auth.wait.hours": "{n} ساعت",

  // Onboarding profile
  "onboardingProfile.title": "مشخصات شما",
  "onboardingProfile.subtitle": "تا کسانی که با آن‌ها حساب مشترک دارید، شما را بشناسند.",
  "onboardingProfile.signedInHint": "وارد شده به نام {email}",
  "onboardingProfile.continue": "ادامه",
  "onboardingProfile.nameRequired": "لطفاً نام خود را وارد کنید",
  "onboardingProfile.shopRequired": "لطفاً برای کاتای خود نام بگذارید",
  "onboardingProfile.joinExisting": "به جای آن به کاتای موجود می‌پیوندم",

  "onboardingKaata.title": "برای کاتای‌تان نام بگذارید",
  "onboardingKaata.subtitle":
    "کاتا حساب همه را در یک جا نگه می‌دارد. برای دکان یا خانهٔ خود نامی انتخاب کنید.",
  "onboardingKaata.name.label": "نام کاتا",
  "onboardingKaata.name.placeholder": "خوراکه فروشی احمد",
  "onboardingKaata.name.required": "لطفاً برای کاتای‌تان نام بگذارید",
  "onboardingKaata.currency.label": "ارز",
  "onboardingKaata.currency.hint":
    "ارز پیش‌فرض ثبت‌های تازه. در همین کاتا از ارزهای دیگر هم استفاده کرده می‌توانید.",
  "onboardingKaata.submit": "ساختن کاتا",

  // Onboarding completion (success screen)
  "onboardingSuccess.title": "کاتای شما آماده است",
  "onboardingSuccess.body":
    "یک نفر را اضافه کنید و داد و گرفت‌تان را ثبت کنید. کاتا بیلانس را برای‌تان حساب می‌کند.",
  "onboardingSuccess.ledgerLabel": "کاتای شما",
  "onboardingSuccess.cta": "باز کردن کاتای من",

  // Permanent guide screen
  "guide.title": "کاتا چطور کار می‌کند",
  "guide.p1": "کاتا دفتر حساب دکان شماست. یک کاتا تمام حساب‌های یک دکان را نگه می‌دارد.",
  "guide.p2":
    "هر کسی که با او حساب دارید — مشتری یا تأمین‌کننده — یک حساب در داخل کاتای شما دارد. با دکمهٔ پایین سمت راست اضافه‌شان کنید.",
  "guide.p3":
    "در حساب هر شخص، وقتی پول یا جنس می‌دهید «دادم» و وقتی پس می‌گیرید «گرفتم» را ثبت کنید. بیلانس خودش محاسبه می‌شود.",
  "guide.p4":
    "بیش از یک دکان دارید؟ کاتای دیگری بسازید و با زدن روی نام کاتا در بالای صفحه اصلی بین آن‌ها جابه‌جا شوید.",

  // Onboarding restore
  "onboardingRestore.title": "خوش برگشتید",
  "onboardingRestore.checking": "در حال پیدا کردن کاتاهای شما",
  "onboardingRestore.checkingHint": "حساب‌تان برای پیدا کردن اطلاعات ذخیره‌شده بررسی می‌شود.",
  "onboardingRestore.subtitleVaults": "کاتاهای ذخیره‌شده در حساب شما: {count}",
  "onboardingRestore.restore.title": "برگرداندن از کلاد",
  "onboardingRestore.restore.bodyVaults": "افراد، ثبت‌ها و کاتاهای‌تان را روی این تلفون برگردانید.",
  "onboardingRestore.fresh.title": "شروع تازه",
  "onboardingRestore.fresh.body": "یک کاتای نو بسازید. کاتاهای ذخیره‌شدهٔ شما در کلاد می‌مانند.",
  "onboardingRestore.fresh.confirmTitle": "با یک دفتر تمیز شروع می‌کنید؟",
  "onboardingRestore.fresh.confirmBody":
    "کاتاهای پشتیبان‌گرفته‌شدهٔ شما در ابر امن می‌مانند، اما اکنون روی این تلفن بازگردانی نمی‌شوند. می‌توانید بعداً دوباره وارد شوید تا آن‌ها را بازگردانی کنید.",
  "onboardingRestore.restoring": "در حال بازیابی کاتای شما…",
  "onboardingRestore.tryAgain": "دوباره تلاش کنید",
  "onboardingRestore.startFresh": "شروع تازه",
  "onboardingRestore.errorTitle": "بازیابی ممکن نشد",
  "onboardingRestore.errorSessionExpired": "نشست شما منقضی شد. برای بازیابی دوباره وارد شوید.",
  "onboardingRestore.signInAgain": "دوباره وارد شوید",
  "onboardingRestore.errorTimeout": "شبکه خیلی کند بود. با اتصال بهتر دوباره تلاش کنید.",
  "onboardingRestore.errorGeneric": "مشکلی پیش آمد. دوباره تلاش کنید.",

  // Tour deprecated — keys removed alongside English. See
  // docs/tour-redesign.md for the postmortem.

  // Profile menu — only the live keys remain (Phase 7 D-ACCOUNT-PAGE-ROLE
  // killed the /account screen and its dependent strings; the preferences row
  // was folded into /vault/settings).

  // "Different account on this phone?" for every provider (see the en table).
  "account.differentAccount.title": "حساب دیگری در این تلفون",
  "account.differentAccount.body":
    "این تلفون به {oldEmail} وصل است. شما با {newEmail} وارد می‌شوید. می‌خواهید چه کار کنید؟",
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
  "home.total.title": "بیلانس‌ها",
  "home.total.label.pay": "قابل پرداخت",
  "home.total.nextCurrency": "واحد پول بعدی",
  "home.total.previousCurrency": "واحد پول قبلی",
  "home.total.pending":
    "حساب‌های مشترک هنوز در حال دانلود است. مجموع‌ها پس از آماده‌شدن نمایش داده می‌شود.",
  "home.empty.title": "هنوز مشتری‌ای نیست",
  "home.empty.subtitle": "برای شروع ثبت حساب، یک مشتری اضافه کنید.",
  "home.empty.collect.title": "هنوز چیزی برای وصول نیست",
  "home.empty.collect.subtitle":
    "با دکمهٔ پایین سمت راست برای کسی که با او حساب دارید یک حساب بسازید — برای هر مشتری یکی.",
  "home.empty.pay.title": "هنوز از کسی قرضدار نیستید",
  "home.empty.pay.subtitle":
    "وقتی جنس می‌گیرید یا پول قرض می‌کنید، از صفحه آن شخص ثبت کنید — همین‌جا ظاهر می‌شود.",
  "home.from.someone": "از یک نفر",
  "home.from.many": "از {count} نفر",

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
  "person.ping.button": "فرستادن یادآوری در واتساپ",
  "person.ping.hint": "بیلانس و ثبت‌های اخیر را با {name} شریک سازید.",
  "person.ping.preparing": "در حال آماده‌کردن یادآوری…",
  "person.ping.opening": "در حال بازکردن واتساپ…",
  "person.search.placeholder": "جستجو: یادداشت یا مقدار",
  "person.search.clear": "پاک‌کردن جستجو",
  "person.date.title": "فیلتر بر اساس تاریخ",
  "person.date.all": "همه تاریخ‌ها",
  "person.date.today": "امروز",
  "person.date.last7": "۷ روز گذشته",
  "person.date.last30": "۳۰ روز گذشته",
  "person.date.month": "این ماه",
  "person.date.custom": "بازه دلخواه",
  "person.date.pickStart": "تاریخ آغاز را انتخاب کنید",
  "person.date.pickEnd": "تاریخ پایان را انتخاب کنید، یا برای یک روز همان روز را دوباره لمس کنید",
  "person.date.rangeReady": "برای بازه تازه، یک تاریخ را لمس کنید",
  "person.date.chooseRange": "دو تاریخ برای بازه انتخاب کنید",
  "person.date.startTime": "ساعت آغاز",
  "person.date.endTime": "ساعت پایان",
  "person.date.invalidTimes": "ساعت‌های معتبر انتخاب کنید؛ پایان نباید پیش از آغاز باشد.",
  "person.date.timeUnavailable": "انتخاب ساعت باز نشد. دوباره کوشش کنید.",
  "person.date.apply": "اعمال بازه",
  "person.date.clear": "پاک‌کردن فیلتر تاریخ",
  "person.date.active": "فیلتر تاریخ: {range}",
  "person.date.previousMonth": "ماه گذشته",
  "person.date.nextMonth": "ماه آینده",
  "person.date.weekday.0": "ی",
  "person.date.weekday.1": "د",
  "person.date.weekday.2": "س",
  "person.date.weekday.3": "چ",
  "person.date.weekday.4": "پ",
  "person.date.weekday.5": "ج",
  "person.date.weekday.6": "ش",
  "customers.listOptions": "ترتیب و گروه",
  "customers.search": "جستجوی مشتری‌ها",
  "search.openHint": "جستجو، فیلترها و نتیجه‌های مطابق را باز می‌کند.",
  "search.filters": "فیلترها",
  "search.showResults": "نمایش نتیجه‌ها",
  "search.clearQuery": "پاک‌کردن جستجو",
  "search.clearAll": "پاک‌کردن همهٔ فیلترها",
  "customers.search.clear": "پاک‌کردن جستجوی مشتری‌ها",
  "customers.search.title": "نتیجه‌های جستجو",
  "customers.search.result": "۱ مشتری مطابق جستجو",
  "customers.search.results": "{count} مشتری مطابق جستجو",
  "customers.noResults": "مشتری مطابق جستجو پیدا نشد",
  "customers.noTallies": "هنوز ثبتی نیست",
  "customers.balanceFilter": "بیلانس‌ها",
  "customers.balanceFilter.all": "همهٔ مشتری‌ها",
  "customers.balanceFilter.collect": "فقط قابل وصول",
  "customers.balanceFilter.pay": "فقط قابل پرداخت",
  "customers.balanceFilter.help":
    "بیلانس همهٔ ارزها در نظر گرفته می‌شود؛ یک مشتری می‌تواند در هر دو فیلتر ظاهر شود.",
  "customers.balanceFilter.clear": "پاک‌کردن فیلتر بیلانس",
  "customers.sort": "ترتیب مشتری‌ها",
  "customers.sort.multiCurrencyHelp": "ترتیب بر اساس مبلغ فقط برای بیلانس‌های یک ارز در دسترس است.",
  "customers.sort.outstanding_name": "مانده‌دارها اول · الف تا ی",
  "customers.sort.recent": "فعالیت تازه",
  "customers.sort.name_asc": "نام · الف تا ی",
  "customers.sort.name_desc": "نام · ی تا الف",
  "customers.sort.amount_desc": "مبلغ · بزرگ‌تر اول",
  "customers.sort.amount_asc": "مبلغ · کوچک‌تر اول",
  "customers.sort.date_asc": "آخرین ثبت · قدیمی‌تر اول",
  "customers.filtered": "{direction}: {shown} از {total} مشتری · {amount} از جمع بالا",
  "groups.filter": "گروه‌ها",
  "groups.filterHelp": "مشتری‌های هر یک از گروه‌های انتخاب‌شده نمایش داده می‌شوند.",
  "groups.all": "همهٔ مشتری‌ها",
  "groups.ungrouped": "بی‌گروه",
  "groups.none": "بدون گروه",
  "groups.manage": "تنظیم گروه‌ها",
  "groups.help":
    "برای این کاتا گروه دلخواه بسازید. هر مشتری می‌تواند در چند گروه باشد. گروه‌ها فهرست را منظم می‌کنند؛ دسترسی یا بیلانس را تغییر نمی‌دهند.",
  "groups.personAction": "گروه‌های مشتری",
  "groups.personHelp": "در این کاتا برای این مشتری یک یا چند گروه انتخاب کنید.",
  "groups.members.help":
    "مشتری‌ها را برای افزودن به این گروه نشانی کنید و برای بیرون کردن، نشانی را بردارید. تغییرات با «تمام» یا هنگام برگشتن ذخیره می‌شوند.",
  "groups.members.viewHelp": "مشتری‌های این گروه.",
  "groups.members.search": "جستجوی مشتری",
  "groups.members.none": "هنوز مشتری‌ای در این گروه نیست.",
  "groups.members.missing": "این گروه دیگر در دسترس نیست.",
  "groups.members.open": "نشان می‌دهد چه کسانی در این گروه هستند",
  "groups.memberCountOne": "{count} مشتری",
  "groups.memberCount": "{count} مشتری",
  "groups.edit": "ویرایش {name}",
  "groups.empty": "هنوز گروهی نیست.",
  "groups.name": "نام گروه",
  "groups.namePlaceholder": "مثلاً خانواده یا محلهٔ غرب",
  "groups.nameInvalid": "نام گروه باید ۱ تا ۴۰ حرف باشد.",
  "groups.nameDuplicate": "گروهی با این نام از قبل وجود دارد.",
  "groups.add": "افزودن گروه",
  "groups.rename": "تغییر نام گروه",
  "groups.archive": "حذف گروه",
  "groups.archiveTitle": "{name} حذف شود؟",
  "groups.archiveHelp":
    "گروه‌های دیگر مشتری‌ها باقی می‌مانند. ثبت‌ها و بیلانس آن‌ها تغییر نمی‌کند.",
  "customers.noGroupResults": "در این بخش مشتری‌ای از گروه‌های انتخاب‌شده نیست.",
  "groups.view": "گروه: {name}",
  "groups.viewMany": "گروه‌ها: {name}",
  "groups.clearFilter": "دوباره همه مشتری‌ها را نشان می‌دهد",
  "reminders.channel": "یادآوری مشتری‌ها",
  "credit.title": "حد قرض",
  "credit.defaultTitle": "حد قرض پیش‌فرض",
  "credit.defaultHelp":
    "برای هر مشتری که حد قرض جداگانه ندارد اعمال می‌شود، از جمله مشتریانی که بعداً اضافه می‌شوند. حد قرض خودِ مشتری همیشه مقدم است.",
  "credit.usesDefault":
    "این مشتری حد قرض جداگانه ندارد، پس حد قرض پیش‌فرض کاتا بر او اعمال می‌شود. با ذخیره کردن در اینجا، حد جداگانه برایش تعیین می‌شود.",
  "credit.defaultRow": "حد قرض پیش‌فرض",
  "credit.defaultRowHint": "برای مشتریانی که حد جداگانه ندارند",
  "credit.maxCollect": "بیشترین قرض آن‌ها به ما",
  "credit.maxPay": "بیشترین قرض ما به آن‌ها",
  "credit.unlimited": "بدون حد",
  "credit.warnMode": "فقط هشدار بده",
  "credit.hardMode": "محدودکردن ثبت‌کننده‌ها",
  "credit.editorsMode": "محدودکردن ویرایشگرها و ثبت‌کننده‌ها",
  "credit.modeHelp":
    "هشدار یا محدودیت را انتخاب کنید. اجازهٔ جداگانهٔ هر عضو می‌تواند تعیین کند چه کسی باید حد قرض را رعایت کند.",
  "credit.hardHelp":
    "کارمندانی که محدودیت دارند، برای ثبت‌هایی که ماندهٔ قرض را تغییر می‌دهد به بررسی آنلاین نیاز دارند. ثبت‌هایی که قرض موجود را کم می‌کند مجاز می‌ماند. مالک و مدیر می‌توانند از حد بگذرند؛ اجازه‌های جداگانهٔ اعضا فقط بر حدهای محدود اعمال می‌شود.",
  "credit.forCustomer": "برای {name}",
  "credit.zeroHelp": "برای بدون حد، خانه را خالی بگذارید. ۰ یعنی در آن طرف هیچ قرضی نه.",
  "credit.loadFailed": "حد قرض بارگیری نشد. برگردید و دوباره باز کنید.",
  "credit.limitLeft": "حد {limit} · {left} باقی",
  "credit.limitOver": "حد {limit} · {over} بیشتر",
  "credit.clerksNeedSignIn":
    "پیش از فعال‌کردن محدودیت، از هر کارمندی که محدودیت دارد بخواهید وارد حساب شود و همگام کند.",
  "credit.warning": "این ثبت از حد قرض بیشتر می‌شود",
  "credit.blocked": "حد قرض گذشته است. این ثبت حساب نشد.",
  "credit.pending": "منتظر تأیید سرور",
  "credit.pendingChange": "این تغییر منتظر تأیید سرور است. ثبت قبلی بدون تغییر باقی مانده است.",
  "credit.refusedChange":
    "این تغییر به دلیل گذشتن از حد قرض رد شد. ثبت قبلی بدون تغییر باقی مانده است.",
  "credit.intentEdit": "ویرایش ثبت",
  "credit.intentDelete": "حذف ثبت",
  "credit.pendingHold": "منتظر بررسی حد قرض از طرف سرور. تا تأیید نشده، چیزی تحویل ندهید.",
  "credit.signInToSend": "ارسال نشده: وارد حساب شوید تا سرور آن را بررسی کند",
  "credit.refusalOne": "حد قرض جلوی ثبت {name} را گرفت: {what}، {when}",
  "credit.refusalMany":
    "حد قرض در ۳۰ روز گذشته جلوی {count} ثبت را گرفت. آخرین از {name}: {what}، {when}",
  "credit.refusalSomeone": "یک کارمند",
  "tab.savedSignIn": "در این تلفون ذخیره شد. برای فرستادن به {name} وارد حساب شوید.",
  "credit.refused": "بیشتر از حد قرض — حساب نشده",
  "credit.intentsTitle": "منتظر / حساب نشده",
  "credit.onlineSave":
    "وقتی وارد حساب هستید، هر ذخیرهٔ حد قرض به اینترنت نیاز دارد تا همه تلفون‌ها یک قاعده داشته باشند.",
  "credit.saveFailed": "حد قرض ذخیره نشد. اتصال را بررسی کنید و دوباره کوشش کنید.",
  "credit.limitInvalid": "صفر یا مبلغ مثبت با حداکثر دو رقم اعشار وارد کنید",
  "credit.recorded": "حساب شد",
  "credit.statusOver": "بیشتر از حد قرض",
  "credit.statusNear": "نزدیک حد قرض",
  "credit.save": "ذخیرهٔ حد قرض",
  "credit.saved": "حد قرض ذخیره شد",
  "reminders.title": "یادآوری‌ها",
  "reminders.personal": "فقط برای شما در این تلفن است. چیزی به مشتری فرستاده نمی‌شود.",
  "reminders.add": "افزودن یادآوری",
  "reminders.edit": "تغییر یادآوری",
  "reminders.once": "یک‌بار",
  "reminders.daily": "هر روز",
  "reminders.weekly": "هر هفته",
  "reminders.monthly": "ماهانه",
  "reminders.chooseWeekdays": "هر روزی را که می‌خواهید انتخاب کنید.",
  "reminders.chooseOneDay": "حداقل یک روز را انتخاب کنید.",
  "reminders.repeatEvery": "تکرار پس از هر",
  "reminders.oneMonth": "۱ ماه",
  "reminders.monthCount": "{months} ماه",
  "reminders.monthlyDate": "روز و ماه تکرار (میلادی)",
  "reminders.monthlyCalendar":
    "یادآوری‌های ماهانه با تقویم میلادی تکرار می‌شوند. روز ۱ تا ۲۸ را انتخاب کنید تا در هر ماه موجود باشد.",
  "reminders.monthDayRange": "یک روز از ۱ تا ۲۸ را انتخاب کنید.",
  "reminders.onMonthlyDay": "روز {day} هر ماه میلادی، ساعت {time}",
  "reminders.onMonthInterval": "هر {months} ماه میلادی، روز {day}، ساعت {time}",
  "reminders.scheduleLimit":
    "جای اعلان برای این برنامه در این تلفن نمانده است. روزهای کمتر یا فاصلهٔ طولانی‌تر انتخاب کنید، یا یک یادآوری دیگر را حذف کنید.",
  "reminders.date": "تاریخ",
  "reminders.time": "وقت",
  "reminders.weekday": "روز هفته",
  "reminders.everyDay": "هر روز ساعت {time}",
  "reminders.everyWeekday": "هر {weekday} ساعت {time}",
  "reminders.next": "نوبت بعد: {date}",
  "reminders.due": "وقتش رسیده",
  "reminders.dueShortcut": "یادآوری‌های رسیده: {count}",
  "reminders.all": "همه",
  "reminders.empty": "هنوز یادآوری ندارید.",
  "reminders.noDue": "اکنون وقت هیچ یادآوری نرسیده است.",
  "reminders.markDone": "انجام شد",
  "reminders.remove": "حذف یادآوری",
  "reminders.removeConfirm": "این یادآوری حذف شود؟",
  "reminders.saved": "یادآوری ذخیره شد.",
  "reminders.future": "تاریخ و وقت آینده را انتخاب کنید.",
  "reminders.unavailable": "این مشتری دیگر در دسترس نیست.",
  "reminders.permissionDenied":
    "ذخیره شد. اعلان‌ها خاموش‌اند؛ این یادآوری در کاتا نشان داده می‌شود.",
  "reminders.notificationsOff":
    "اعلان‌های کاتا خاموش‌اند، پس یادآوری‌ها فقط داخل برنامه دیده می‌شوند. برای اینکه به‌وقت باخبر شوید، آن‌ها را در تنظیمات روشن کنید.",
  "reminders.permissionUnavailable": "ذخیره شد. در این نسخه، یادآوری در کاتا نشان داده می‌شود.",
  "reminders.nativeFailed": "ذخیره شد. اعلان تلفن تنظیم نشد؛ یادآوری در کاتا باقی می‌ماند.",
  "reminders.limit": "در این تلفن تا ۴۰ یادآوری فعال می‌توانید داشته باشید.",
  "reminders.loadFailed":
    "یادآوری‌ها در این تلفن خوانده نشدند. دوباره امتحان کنید؛ اگر باز نشد، کاتا را دوباره باز کنید.",
  "reminders.notifyBody": "وقت یادآوری یک مشتری رسیده است. برای دیدن آن کاتا را باز کنید.",
  "reminders.notifyBodyNamed":
    "وقت آن است که {name} را از حسابش باخبر کنید. برای فرستادن، کاتا را باز کنید.",
  "person.flows.allTime": "همه زمان‌ها",
  "person.flows.gave": "دادم ({count})",
  "person.flows.received": "گرفتم ({count})",
  "person.flows.hint":
    "ثبت‌های داد و گرفت در تاریخچهٔ موجود. بیلانس آغازین به‌عنوان داد و گرفت جدید حساب نمی‌شود.",
  "onboardingCalendar.title": "تقویم خود را انتخاب کنید",
  "onboardingCalendar.subtitle":
    "تاریخ‌ها را به شیوه‌ای که می‌شناسید ببینید. بعداً می‌توانید آن را در حساب تغییر دهید.",
  "person.search.result": "{count} ثبت پیدا شد · بیلانس شامل همه ثبت‌ها است",
  "person.search.results": "{count} ثبت پیدا شد · بیلانس شامل همه ثبت‌ها است",
  "person.search.empty.title": "ثبتی پیدا نشد",
  "person.search.empty.subtitle": "یادداشت یا مقدار دیگری را جستجو کنید یا فیلترها را پاک کنید.",
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
  "personAdd.new": "افزودن شخص",
  "personFind.title": "یافتن شخص",
  "personFind.placeholder": "جستجو با نام یا شماره",
  "personFind.empty.subtitle": "اشخاصی که به این کاتا افزوده شوند، اینجا نمایش داده می‌شوند.",
  "personAdd.firstName.placeholder": "احمد",
  "personAdd.lastName.placeholder": "کریمی",
  "personAdd.add": "افزودن {name}",
  "personAdd.phone.hint": "برای ارسال یادآوری در واتساپ لازم است.",
  "personAdd.phone.invalid":
    "شمارهٔ تلفون کشور انتخاب‌شده را وارد کنید، یا شماره را با + و کد کشور بنویسید.",
  "personAdd.phone.conflict": "این شماره قبلاً برای {name} ثبت شده",
  "personAdd.phone.isSelf": "این شماره خود شماست — نمی‌توانید خودتان را اضافه کنید.",
  "personAdd.save.storageFull": "حافظهٔ گوشی شما پر است. کمی فضا خالی کنید و دوباره امتحان کنید.",
  "personAdd.save.storageBusy":
    "کاتا در حال ذخیرهٔ تغییرات است. کمی صبر کنید و دوباره امتحان کنید.",
  "personAdd.save.failed":
    "ذخیرهٔ این شخص کامل نشد. کاتا را دوباره باز کنید و امتحان کنید. اگر مشکل ادامه داشت، گزارش وضعیت برنامه را بفرستید.",
  "personAdd.section.matches": "نتایج",
  "personAdd.section.existing": "از قبل در این کاتا",
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
  "personAdd.contacts.manage": "مخاطبین بیشتری را در تنظیمات انتخاب کنید",
  "personAdd.contacts.failed":
    "تنظیمات باز نشد. می‌توانید دسترسی به مخاطبین را از تنظیمات تلفن فعال کنید.",
  // Overflow row under the truncated Matches list.
  "personAdd.moreResults": "{count}+ نتیجهٔ دیگر — برای محدود کردن، بیشتر تایپ کنید",
  "personAdd.moreContacts": "برای یافتن مخاطبین بیشتر، نام یا شماره را تایپ کنید.",

  // Tally calculator
  "calculator.open": "باز کردن ماشین حساب",
  "calculator.title": "ماشین حساب",
  "calculator.close": "بستن ماشین حساب",
  "calculator.nextNote": "رفتن به یادداشت",
  "calculator.useAmount": "استفاده از مبلغ",
  "calculator.expression": "محاسبه",
  "calculator.result": "نتیجه",
  "calculator.history": "محاسبات قبلی",
  "calculator.historyTitle": "محاسبات این ثبت",
  "calculator.historyEmpty": "محاسبات شما اینجا نمایش داده می‌شوند.",
  "calculator.clearHistory": "پاک کردن محاسبات قبلی",
  "calculator.backToCalculator": "برگشت به ماشین حساب",
  "calculator.recallCalculation": "استفادهٔ دوباره از محاسبه: {expression}",
  "calculator.clear": "پاک کردن همه",
  "calculator.delete": "پاک کردن آخرین رقم",
  "calculator.add": "جمع",
  "calculator.subtract": "تفریق",
  "calculator.multiply": "ضرب",
  "calculator.divide": "تقسیم",
  "calculator.percent": "فیصد",
  "calculator.equals": "محاسبهٔ نتیجه",
  "calculator.sign": "تغییر علامت",
  "calculator.parentheses": "قوس‌ها",
  "calculator.doubleZero": "دو صفر",
  "calculator.decimal": "نقطهٔ اعشاری",
  "calculator.memory": "حافظه",
  "calculator.memoryClear": "پاک کردن حافظه",
  "calculator.memoryRecall": "آوردن مقدار حافظه",
  "calculator.memoryAdd": "افزودن نتیجه به حافظه",
  "calculator.memorySubtract": "کم کردن نتیجه از حافظه",
  "calculator.invalid": "محاسبه را بررسی کنید.",
  "calculator.divisionByZero": "تقسیم بر صفر ممکن نیست.",
  "calculator.tooComplex": "این محاسبه خیلی طولانی است. چند بخش آن را کم کنید.",
  "calculator.tooLarge": "این مبلغ برای یک ثبت بیش از حد بزرگ است.",
  "calculator.positiveAmount": "مبلغ باید بیشتر از صفر باشد.",
  "calculator.incomplete": "برای استفاده از مبلغ، محاسبه را کامل کنید.",
  "calculator.rounded": "به ۲ رقم اعشار گرد شده",
  "calculator.memoryEmpty": "حافظه خالی است",
  "calculator.helper": "اینجا محاسبه کنید، بعد از مبلغ در ثبت خود استفاده کنید.",

  // Entry
  "entry.amount.label": "مقدار (AFN)",
  "entry.note.label": "یادداشت",
  "entry.date.label": "تاریخ",
  "entry.more.show": "نمایش بیشتر",
  "entry.more.hide": "نمایش کمتر",
  "entry.currency.label": "ارز",
  "entry.currency.fixed": "ارز این ثبت ثابت می‌ماند. برای ارز دیگر، ثبت تازه اضافه کنید.",
  "entry.currency.disabled": "این ارز دیگر برای این کاتا فعال نیست. یک ارز فعال را انتخاب کنید.",
  "currency.view": "نمایش ارز",
  "entry.note.placeholder": "آرد و چای",
  "entry.save": "ذخیره",
  "entry.saveChanges": "ذخیره تغییرات",
  "entry.context.to": "به",
  "entry.context.from": "از",
  "entry.edit.title": "ویرایش · {verb}",
  "entry.edit.hint":
    'جهت قابل تغییر نیست. برای تبدیل به "{otherVerb}" این ثبت را حذف کنید و یکی نو اضافه کنید.',
  "entry.notFound": "این ثبت دیگر وجود ندارد.",
  "entry.showExactTime": "نمایش تاریخ و ساعت دقیق",
  "entry.showRelativeTime": "نمایش زمان گذشته",
  "entry.options": "گزینه‌های ثبت",
  "entry.addedBy": "ثبت‌شده توسط {name}",
  "entry.editedBy": "ویرایش توسط {name}",
  "entry.editedByOnly": "ویرایش‌شده توسط {name}",
  "entry.by.you": "شما",
  "entry.by.self": "{name} (شما)",
  "entry.by.someone": "یکی از اعضا",
  "entry.invalidAmount": "یک مقدار مثبت با حداکثر ۲ رقم اعشار وارد کنید",
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
  "entry.signingUnavailable":
    "ذخیره امن آماده نشد. دوباره امتحان کنید — اگر ادامه داشت، کاتا را دوباره باز کنید.",
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
  "settings.language.option.ps": "پښتو",
  "settings.language.changed": "زبان تغییر کرد.",

  // Calendar system — see the English block for why this is independent of
  // language. "هجری شمسی" with the Afghan zodiac months (حمل … حوت).
  "settings.calendar.label": "تقویم",
  "settings.calendar.option.auto": "خودکار",
  "settings.calendar.option.gregorian": "میلادی",
  "settings.calendar.option.jalali": "هجری شمسی",
  "settings.calendar.option.qamari": "هجری قمری",
  "settings.calendar.hint.qamari":
    "تقویم محاسبه‌شده؛ اگر با دیدن ماه در محل شما فرق کند، در حساب تنظیمش کنید.",
  "settings.qamariOffset.label": "تنظیم تاریخ قمری",
  "settings.qamariOffset.hint": "وقتی تاریخ با دیدن ماه در محل شما یک روز فرق دارد",
  "settings.qamariOffset.none": "بدون تغییر",
  "settings.qamariOffset.later1": "یک روز بعد",
  "settings.qamariOffset.later2": "دو روز بعد",
  "settings.qamariOffset.earlier1": "یک روز قبل",
  "settings.qamariOffset.earlier2": "دو روز قبل",
  "settings.qamariOffset.changed": "تاریخ‌های قمری تنظیم شد",
  "settings.calendar.hint.auto": "از زبان شما پیروی می‌کند",
  "settings.calendar.changed": "تقویم تغییر کرد.",
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
  "currency.title": "انتخاب ارز",
  "currency.search": "جستجو با نام، کد یا نماد ارز",
  "currency.noMatch": "ارزی پیدا نشد.",
  "currency.precisionHint": "کاتا فعلاً برای این ارز تا ۲ رقم اعشار را پشتیبانی می‌کند.",
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
  "share.currencySettled": "🤝 {currency}: تصفیه شده.",
  "share.billUnavailable": "کاتای مکمل ضمیمه نشد. این‌ها فقط بیلانس‌ها هستند.",
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
  "format.am": "ق.ظ",
  "format.pm": "ب.ظ",

  // Common
  "common.cancel": "لغو",
  "common.ok": "باشد",
  "menu.dev.bluetoothTest": "آزمایش بلوتوث (توسعه)",
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
  "person.ping.nudge": "به {name} در واتساپ خبر بدهید؟",
  "person.ping.nudgeSend": "ارسال",
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
  "menu.account.signIn.choose": "ورود به حساب",
  "menu.account.signIn.apple": "ورود با اپل",
  "menu.account.signIn.email": "ورود با ایمیل",
  "menu.account.signIn.toast": "ورود انجام شد",
  "menu.account.signIn.partialToast":
    "وارد شدید، اما {count} کاتا بازیابی نشد. برای تلاش دوباره، دوباره وارد شوید.",
  "menu.account.signIn.failed": "ورود ناموفق — دوباره کوشش کنید",
  "auth.error.recoveryUnavailable":
    "وارد شدید، اما کاتاهای شما بازیابی نشدند. اتصال انترنت را بررسی کنید و دوباره امتحان کنید.",
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
  // Account → Sign-in (see the en table).
  "account.signin.section": "ورود",
  "account.signin.email": "ایمیل",
  "account.signin.loginEmail": "ورود با رمز: {email}",
  "account.signin.password.set": "گذاشتن رمز",
  "account.signin.password.setHint": "با ایمیل و رمز هم وارد شوید",
  "account.signin.password.change": "تغییر رمز",
  "account.signin.password.remove": "حذف رمز",
  "account.signin.password.removeHint": "تنها با گوگل یا اپل وارد شوید",
  "account.signin.username": "نام کاربری",
  "account.signin.username.none": "گذاشته نشده",
  "account.signin.username.hint": "به جای ایمیل برای ورود به کار ببرید",
  "account.signin.loading": "در حال بارگیری جزئیات ورود…",
  "account.signin.failed": "جزئیات ورود بار نشد. برای تلاش دوباره بزنید.",
  "account.signin.network": "به کاتا وصل نشد. اتصال را بررسی کنید و دوباره امتحان کنید.",
  "account.signin.error": "نشد. دوباره امتحان کنید.",
  "accountPassword.title.set": "گذاشتن رمز",
  "accountPassword.title.change": "تغییر رمز",
  "accountPassword.set.body":
    "یک رمز کاتا بگذارید تا با ایمیل خود در هر تلفونی وارد شوید. اول یک کود به این آدرس می‌فرستیم.",
  "accountPassword.set.relayNote":
    "حساب اپل شما آدرس ایمیل خود را پنهان می‌کند، پس آدرسی را بنویسید که می‌توانید باز کنید.",
  "accountPassword.set.codeSent": "یک کود 6 رقمی به {email} فرستادیم. آن را با رمز نو بنویسید.",
  "accountPassword.set.submit": "ذخیرهٔ رمز",
  "accountPassword.set.done": "رمز ذخیره شد. حالا می‌توانید با {email} و این رمز وارد شوید.",
  "accountPassword.change.current": "رمز فعلی",
  "accountPassword.change.body": "از این حساب در همهٔ تلفون‌های دیگر خارج می‌شوید.",
  "accountPassword.change.submit": "تغییر رمز",
  "accountPassword.change.done": "رمز تغییر کرد. از این حساب در تلفون‌های دیگر خارج شدید.",
  "accountPassword.loadFailed": "حساب شما بار نشد. اتصال را بررسی کنید و دوباره امتحان کنید.",
  "accountPassword.set.fixedEmail": "یک کود 6 رقمی به {email} می‌فرستیم.",
  "accountPassword.remove.title": "رمز خود را حذف می‌کنید؟",
  "accountPassword.remove.body":
    "تنها با گوگل یا اپل وارد خواهید شد. از این حساب در تلفون‌هایی که با رمز وارد شده‌اند، خارج می‌شوید.",
  "accountPassword.remove.cta": "حذف رمز",
  "accountPassword.remove.done": "رمز حذف شد",
  "accountUsername.title": "نام کاربری",
  "accountUsername.body":
    "نام کاربری هنگام ورود با رمز به جای ایمیل کار می‌کند. تنها شما آن را می‌بینید.",
  "accountUsername.rules":
    "3 تا 30 حرف، عدد یا نشانه؛ فقط حرف‌های کوچک انگلیسی، عدد، _ و .؛ با یک حرف شروع شود.",
  "accountUsername.save": "ذخیرهٔ نام کاربری",
  "accountUsername.remove": "حذف نام کاربری",
  "accountUsername.saved": "نام کاربری ذخیره شد",
  "accountUsername.removed": "نام کاربری حذف شد",
  "accountUsername.needsPassword": "اول یک رمز بگذارید: نام کاربری تنها با رمز کار می‌کند.",
  "menu.account.signOut.confirm.title": "خارج می‌شوید؟",
  "menu.account.signOut.confirm.body":
    "از حساب {email} خارج می‌شوید. کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.bodyGeneric":
    "کاتاهای محلی روی تلفون می‌مانند، اما تا ورود دوباره همگام‌سازی و بازیابی کلاد کار نمی‌کند.",
  "menu.account.signOut.confirm.cta": "خروج",
  "menu.account.switch": "تعویض حساب",
  "menu.account.localOnlyHint": "برای پشتیبان‌گیری و همگام‌سازی بین تلفون‌ها وارد شوید.",
  "menu.about": "درباره",
  "account.appHealth.section": "وضعیت برنامه",
  "account.appHealth.details": "عیب‌یابی مفصل",
  "account.appHealth.detailsHint": "اطلاعات حافظه و خرابی",
  "account.privacy.section": "حریم خصوصی و داده‌ها",
  "account.privacy.label": "سیاست حریم خصوصی",
  "account.deleteAccount.label": "حذف حساب",
  "account.deleteAccount.hint": "برای بازیابی، تا ۳۰ روز دوباره وارد شوید",
  "account.deleteAccount.confirm.title": "حساب‌تان حذف شود؟",
  "account.deleteAccount.confirm.body":
    "نخست از ثبت‌های ذخیره‌شدهٔ شما نسخهٔ ابری می‌گیریم، سپس شما خارج می‌شوید و معلومات این تلفون پاک می‌شود. حساب و معلومات ابری شما ۳۰ روز نگه داشته می‌شود و پس از آن برای همیشه حذف می‌گردد. برای لغو حذف و بازیابی معلومات ابری که هنوز به آن دسترسی دارید، ظرف ۳۰ روز دوباره وارد شوید. یادآوری‌های شخصی و پیش‌نویس‌های «ارسال نشده» فقط در همین تلفون هستند و از بین می‌روند؛ هر کدام را که لازم دارید یادداشت کنید. از صفحهٔ مشتری، صورت‌حساب حساب‌های مشترکی را که دیگر به آن‌ها دسترسی ندارید پیش از حذف خروجی بگیرید. معلوماتی که قبلاً برای همیشه پاک شده برنمی‌گردد. طرف‌های دیگر سابقهٔ حساب مشترک را نگه می‌دارند. حذف حساب هیچ بیلانسی را تصفیه نمی‌کند.",
  "account.deleteAccount.confirm.cta": "حذف حساب",
  "account.deleteAccount.preparing": "در حال ذخیرهٔ نسخهٔ بازیابی…",
  "account.deleteAccount.backupFailed":
    "حذف تکمیل نشد. معلومات این تلفون را نگه دارید، اتصال انترنت را بررسی کنید و پیش از تلاش دوباره، همگام‌سازی را تکمیل کنید.",
  "account.deleteAccount.graceUnavailable":
    "امکان بازیابی هنوز آماده نیست. حساب و معلومات این تلفون نگه داشته شده‌اند. بعداً دوباره تلاش کنید.",
  "account.deleteAccount.recovered": "حذف لغو شد. کاتاهای ابری شما قابل بازیابی است.",
  "account.deleteAccount.lateEdits":
    "تغییرهای تازه در این تلفون محفوظ است. با همان حساب دوباره وارد شوید تا حذف لغو شود و این تغییرها در ابر ذخیره گردد.",
  "account.deleteAccount.restoring": "حذف لغو شد. کاتاهای شما در حال بازیابی است…",
  "account.deleteAccount.failed":
    "حذف حساب ناموفق بود. اتصال‌تان را بررسی کنید و دوباره تلاش کنید.",
  "account.deleteAccount.authRequired":
    "پیش از حذف حساب دوباره وارد شوید. دفتر این تلفن حذف نشده است.",
  "account.retired.title": "حساب این تلفون حذف شده است",
  "account.retired.body":
    "حسابی که این تلفون آخرین بار با آن وارد شده بود، حذف شده است. کاتاهای شما در این تلفون هنوز کار می‌کنند. اگر کمتر از ۳۰ روز از حذف آن گذشته است، با همان حساب دوباره وارد شوید تا حذف لغو شود و همه چیز برگردد. در غیر آن، برای ورود یا پشتیبان‌گیری دوباره، نخست از معلومات مورد نیازتان خروجی بگیرید، سپس این تلفون را از نو تنظیم کنید. این کار همه چیزهایی را که کاتا روی این تلفون نگه می‌دارد پاک می‌کند.",
  "account.retired.pendingTitle": "حذف حساب در انتظار است",
  "account.retired.pendingBody":
    "حساب این تلفون در {date} برای همیشه حذف می‌شود. پیش از آن با همان حساب دوباره وارد شوید تا حذف لغو شود و همه چیز برگردد. تا آن وقت کاتاهای شما در این تلفون کار می‌کنند.",
  "account.retired.signInCancel": "ورود و لغو حذف",
  "account.retired.reset": "از نو تنظیم کردن این تلفون",
  "account.retired.confirm.title": "این تلفون از نو تنظیم شود؟",
  "account.retired.confirm.body":
    "این کار همه چیزهایی را که کاتا روی این تلفون نگه می‌دارد، از جمله همهٔ کاتاها، افراد و ثبت‌ها، پاک می‌کند. نخست از معلومات مورد نیازتان خروجی بگیرید. این کار قابل بازگشت نیست.",
  "account.retired.confirm.cta": "پاک کردن و از نو تنظیم",
  "account.retired.failed": "از نو تنظیم کردن این تلفون ناکام شد. دوباره کوشش کنید.",

  // Vault create (Phase 5.2 — Add a Kaata)
  "vaultNew.title": "برای کاتای‌تان نام بگذارید",
  "vaultNew.titleForced": "برای ادامه، نام کاتا را بنویسید",
  "vaultNew.name.label": "نام کاتا",
  "vaultNew.name.placeholder": "مثلاً شخصی یا کاری",
  "vaultNew.name.required": "نام لازم است",
  "vaultNew.currency.label": "ارز پیش‌فرض",
  "vaultNew.currency.hint":
    "ارز پیش‌فرض ثبت‌های تازه. بیلانس ارزهای دیگر در همین کاتا جدا نگه‌داری می‌شود.",
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
    "۱. با همان حساب کاتا وارد شوید.\n" +
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
    "تلفون دیگر باید با همان حساب کاتای این یکی وارد شده باشد. برای دعوت دیگری (حساب دیگر)، از «دعوت عضو» استفاده کنید.",
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
  "vaultPairScan.error.signInRequired": "ابتدا با همان حساب تلفون دیگر وارد شوید.",
  "vaultPairScan.error.accountMismatch":
    "این کود برای حساب دیگری ساخته شده. از مالک بخواهید دعوت ایمیلی بفرستد.",
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
  "pairLink.signin.body": "برای تکمیل جفت‌سازی، با همان حساب تلفون دیگر وارد شوید.",
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
    "این لینک برای حساب دیگری ساخته شده. از مالک بخواهید دعوت ایمیلی بفرستد.",

  "common.done": "تمام",
  "common.close": "بستن",
  "common.hideKeyboard": "پنهان‌کردن صفحه‌کلید",
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
  "vaultSettings.name.save": "ذخیره",
  "vaultSettings.currency.label": "ارز پیش‌فرض",
  "vaultSettings.currency.hint":
    "برای ثبت‌های تازه به‌صورت خودکار انتخاب می‌شود. هر ثبت ذخیره‌شده ارز خودش را نگه می‌دارد.",
  "vaultSettings.currencies.label": "ارزهای این کاتا",
  "vaultSettings.currencies.search": "جستجوی ارزها",
  "vaultSettings.currencies.limit":
    "حداکثر ۶۴ ارز را می‌توانید فعال کنید. برای افزودن ارز دیگر، یکی را غیرفعال کنید.",
  "vaultSettings.currencies.hint":
    "ارزهای ثبت‌های تازه را انتخاب کنید. برای تعیین ارز پیش‌فرض، ستاره را بزنید. ثبت‌های قبلی ارز خود را نگه می‌دارند.",
  "vaultSettings.currencies.default": "ارز پیش‌فرض",
  "vaultSettings.currencies.defaultSummary": "پیش‌فرض: {currency}",
  "vaultSettings.currencies.selectedCount": "{count} انتخاب شده",
  "vaultSettings.currencies.setDefault": "{currency} را پیش‌فرض بسازید",
  "vaultSettings.currencies.changed":
    "تنظیمات ارز تغییر کرده است. این فهرست را ببندید و دوباره باز کنید تا گزینه‌های تازه را ببینید.",
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

  "ownershipTransfer.title": "انتقال مالکیت",
  "ownershipTransfer.intro":
    "کسی را دعوت کنید تا مالک این کاتا شود. تا زمان پذیرش، شما مالک می‌مانید و پس از آن به عنوان ویرایشگر دسترسی خواهید داشت. پیش از انتقال، کاتا را در تمام تلفون‌هایی که از این کاتا استفاده می‌کنند به‌روز کنید.",
  "ownershipTransfer.ownerOnly": "فقط مالک می‌تواند مالکیت این کاتا را منتقل کند.",
  "ownershipTransfer.signedOut": "برای ایجاد دعوت مالکیت، وارد حساب خود شوید.",
  "ownershipTransfer.offline": "برای مدیریت دعوت مالکیت به انترنت وصل شوید.",
  "ownershipTransfer.unavailable":
    "برای انتقال، این کاتا باید فعال، کاملاً همگام‌شده و متعلق به حسابی باشد که با آن وارد شده‌اید.",
  "ownershipTransfer.loadFailed": "بررسی دعوت مالکیت ممکن نشد. پیش از ساختن لینک دوباره تلاش کنید.",
  "ownershipTransfer.refresh": "بررسی وضعیت",
  "ownershipTransfer.recipient": "مالک جدید",
  "ownershipTransfer.emailHint":
    "برای پذیرش باید با همین ایمیل وارد شود. فرستادن لینک به شخص دیگر به او مالکیت نمی‌دهد.",
  "ownershipTransfer.create": "ساختن لینک مالکیت",
  "ownershipTransfer.confirmTitle": "مالک جدید دعوت شود؟",
  "ownershipTransfer.confirmBody":
    "{email} می‌تواند مالکیت تمام این کاتا، همراه با اعضا و حساب‌های مشترک آن را بپذیرد. تا زمان پذیرش، شما مالک می‌مانید. پس از پذیرش به عنوان ویرایشگر می‌مانید و فقط مالک جدید می‌تواند مالکیت را دوباره به شما برگرداند.",
  "ownershipTransfer.created": "دعوت مالکیت ایجاد شد",
  "ownershipTransfer.pending": "در انتظار پذیرش",
  "ownershipTransfer.expires": "انقضا: {when}",
  "ownershipTransfer.pendingHint":
    "شما هنوز مالک هستید. گیرنده فقط پس از ورود به حساب و پذیرش این دعوت مالک می‌شود.",
  "ownershipTransfer.linkNotStored":
    "برای حفظ حریم خصوصی، لینک فقط در صفحه‌ای که ساخته شده در دسترس است. برای لینک جدید، این دعوت را لغو و دعوت دیگری ایجاد کنید.",
  "ownershipTransfer.shareEmail": "ارسال با ایمیل",
  "ownershipTransfer.shareMessage":
    "شما را دعوت می‌کنم تا مالک {name} در کاتا شوید. با ایمیل دعوت‌شده وارد شوید و انتقال را این‌جا بررسی کنید: {url}",
  "ownershipTransfer.emailSubject": "دعوت مالکیت برای {name}",
  "ownershipTransfer.shareUnavailable":
    "باز کردن برنامهٔ پیام‌رسان ممکن نشد. می‌توانید لینک را کپی کنید.",
  "ownershipTransfer.cancel": "لغو دعوت",
  "ownershipTransfer.cancelTitle": "دعوت مالکیت لغو شود؟",
  "ownershipTransfer.cancelBody":
    "لینک دیگر کار نخواهد کرد. شما مالک می‌مانید و می‌توانید شخص دیگری را دعوت کنید.",
  "ownershipTransfer.cancelled": "دعوت مالکیت لغو شد",
  "ownershipTransfer.alreadyPending":
    "یک دعوت مالکیت در انتظار است. پیش از ساختن دعوت دیگر، وضعیت آن را بررسی یا آن را لغو کنید.",
  "ownershipTransfer.selfTransfer": "شخص دیگری را انتخاب کنید. شما از قبل مالک این کاتا هستید.",
  "ownershipTransfer.failed":
    "تغییر دعوت مالکیت ممکن نشد. اتصال انترنت را بررسی و دوباره تلاش کنید.",
  "ownershipTransfer.existingMember": "انتخاب یک عضو فعلی",
  "ownershipTransfer.existingMemberHint": "انتقال مستقیم به کسی که در این کاتا عضو است",

  // Members — Persian
  "members.title": "اعضا",
  "members.section.members": "اعضا ({count})",
  "members.section.pending": "دعوت‌های در انتظار ({count})",
  "members.empty": "هنوز عضوی نیست.",
  "members.nameUnavailable": "نام در دسترس نیست",
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
  "members.toast.transferSyncRequired":
    "این تیلفون باید پیش از انتقال مالکیت همگام‌سازی را تکمیل کند. به انترنت وصل شوید، بگذارید این کاتا همگام شود و سپس دوباره تلاش کنید.",
  "members.toast.transferNotMember": "{name} دیگر عضو این کاتا نیست. لیست تازه‌سازی شد.",
  "members.toast.transferPartialRecovered":
    "انتقال کامل نشد. هیچ تغییری اعمال نشد — لطفاً دوباره تلاش کنید.",
  "members.toast.transferPartialUnrecovered":
    "انتقال نیمه‌انجام شد: اکنون دو مالک وجود دارد. روی یکی از آن‌ها ضربه بزنید تا اصلاح شود.",
  "members.sheet.title": "مدیریت {name}",
  "members.sheet.makeEditor": "ویرایشگر کردن",
  "members.sheet.makeViewer": "بیننده کردن",
  "members.sheet.makeManager": "مدیر کردن",
  "members.rolesHelp":
    "مدیرها کارکنان و حد قرض را مدیریت می‌کنند. تنها مالک می‌تواند مدیر تعیین کند، مالکیت را انتقال دهد یا این کاتا را بایگانی کند.",
  "members.credit.action": "اجازه‌های حد قرض",
  "members.credit.title": "اجازهٔ قرض · {name}",
  "members.credit.inherit": "مطابق نقش",
  "members.credit.inheritHint": "محدودیت مشتری را مطابق نقش این عضو اعمال کن.",
  "members.credit.enforce": "باید حدهای محدود را رعایت کند",
  "members.credit.enforceHint":
    "هر حد محدود را اعمال کن، حتی اگر نقش این عضو معاف باشد. حدهای فقط هشدار همچنان هشدار می‌مانند.",
  "members.credit.bypass": "می‌تواند از حد بگذرد",
  "members.credit.bypassHint":
    "به این عضو اجازهٔ گذشتن از حدهای محدود را بده. هشدارهای قرض همچنان نشان داده می‌شوند.",
  "members.credit.onlineRequired": "برای تغییر اجازهٔ اعضا وارد حساب شوید و به اینترنت وصل شوید.",
  "members.credit.loadFailed":
    "اجازه‌های فعلی بارگیری نشد. اتصال را بررسی کنید و دوباره کوشش کنید.",
  "members.credit.saveFailed": "اجازه ذخیره نشد. اتصال را بررسی کنید و دوباره کوشش کنید.",
  "members.credit.memberNeedsSignIn":
    "از این عضو بخواهید وارد حساب شود و همگام کند، سپس اجازهٔ قرض او را تغییر دهید.",
  "members.credit.saved": "اجازهٔ قرض ذخیره شد",
  "members.credit.working": "در حال بررسی اجازه‌های قرض…",
  "members.appleHiddenEmail": "حساب اپل · ایمیل پنهان",
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
  "invite.link.editorDisclosure":
    "ویرایشگرها می‌توانند در این کاتا ثبت اضافه، ویرایش و حذف کنند. در حساب‌های مشترک، ثبت‌های طرف مقابل را تأیید یا رد (نهایی) و حساب مشترک را قطع هم می‌توانند.",
  "invite.managerNote":
    "مالک می‌تواند برای مدیریت کارکنان و حد قرض مدیر تعیین کند. اول شخص را دعوت کنید، بعد در «اعضا» روی نامش بزنید و «مدیر کردن» را انتخاب کنید.",
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
    "دعوت‌شده باید با حسابی بپذیرد که همین ایمیل را دارد. آدرس‌های جیمیل بدون نقطه مطابقت می‌شوند.",
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
  "ownershipAccept.title": "دعوت برای مالکیت",
  "ownershipAccept.heading": "مالک {name} شوید",
  "ownershipAccept.body":
    "{inviter} می‌خواهد مالکیت این کاتا را به شما بدهد. شما اعضا، تنظیمات و بایگانی آن را مدیریت خواهید کرد و او به عنوان ویرایشگر می‌ماند. با ایمیلی وارد شوید که برای آن دعوت شده‌اید.",
  "ownershipAccept.accept": "پذیرفتن مالکیت",
  "ownershipAccept.done": "دعوت مالکیت {name} پذیرفته شد",
  "ownershipAccept.unavailable":
    "این دعوت مالکیت منقضی یا لغو شده است، یا برای حساب شما نیست. با ایمیلی وارد شوید که مالک دعوت کرده است، یا از او لینک تازه بخواهید.",
  "inviteAccept.invalidLink": "لینک دعوت معتبر نیست",
  "inviteAccept.signin.body":
    "برای پذیرفتن این دعوت وارد شوید، با حسابی که همان ایمیلِ دریافت‌کنندهٔ دعوت را دارد.",
  "inviteAccept.signin.cta": "ورود",
  "inviteAccept.confirm.title": "به {name} بپیوندید؟",
  "inviteAccept.confirm.body": "{inviter} شما را دعوت کرده است تا به عنوان {role} بپیوندید.",
  "inviteAccept.confirm.someone": "کسی",
  "inviteAccept.confirm.accept": "پذیرفتن و پیوستن",
  "inviteAccept.confirm.decline": "رد کردن",
  "inviteAccept.joining": "در حال پیوستن به کاتا…",
  "inviteAccept.joinedToast": "به {name} پیوستید",
  "inviteAccept.pending.title": "در حال تکمیل اتصال",
  "inviteAccept.pending.body":
    "دعوت شما پذیرفته شد. کاتا را به اینترنت وصل نگه دارید تا راه‌اندازی تکمیل شود. دوباره خودکار تلاش می‌کنیم.",
  "inviteAccept.blocked.title": "راه‌اندازی به کمک نیاز دارد",
  "inviteAccept.blocked.body": "راه‌اندازی تکمیل نشد. از صاحب کاتا کمک بخواهید.",
  "inviteAccept.error.title": "مشکلی پیش آمد",
  "inviteAccept.error.notVisible":
    "این دعوت در حساب شما دیده نمی‌شود. دعوت به یک ایمیل مشخص گره خورده است — با حسابی وارد شوید که همان ایمیلِ دریافت‌کنندهٔ دعوت را دارد.",
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
  "export.savedDownloads": "در پوشهٔ Downloads ذخیره شد: {name}",
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
  "export.doc.customer": "نام مشتری",
  "export.doc.preparedBy": "تهیه‌کننده",
  "export.doc.summarySection": "خلاصهٔ حساب",
  "export.doc.transactionsSection": "لیست ثبت‌ها",
  "export.doc.peopleSection": "لیست اشخاص",
  "export.doc.totalGave": "مجموع دادم",
  "export.doc.totalReceived": "مجموع گرفتم",
  "export.doc.settledOn": "تصفیه شد در {date}",
  "export.doc.clearedBy": "صاف‌شده توسط {name} در {date}",
  "export.doc.clearedUnnamed": "صاف‌شده در {date} (نام ثبت نشده)",
  "export.col.date": "تاریخ",
  "export.col.dateShamsi": "تاریخ شمسی",
  "export.col.dateQamari": "تاریخ قمری",
  "export.col.person": "نام",
  "export.col.phone": "تلفون",
  "export.col.note": "یادداشت",
  "export.col.gave": "دادم",
  "export.col.received": "گرفتم",
  "export.col.balance": "باقی‌مانده",
  "export.col.entries": "ثبت‌ها",
  "export.col.num": "شماره",
  "export.col.amount": "مبلغ",
  "export.col.type": "نوع",
  "export.col.status": "وضعیت",
  "export.col.lastActivity": "آخرین ثبت",
  // نمبر not شناسه — the table's Afghan-vernacular rule (شناسه is Iranian register).
  "export.col.id": "نمبر ثبت",
  "export.record.title": "سابقهٔ مشترک با تأییدهای ثبت‌شده",
  "export.record.explanation":
    "مانده شامل ثبت‌های مشترک تأییدشده و ثبت‌های شخصی است که اینجا جدا مشخص شده‌اند. تغییر خالصِ در انتظار، ماندهٔ تأییدشده‌ای را که در ماندهٔ آغازین پیشنهادی انتقال یافته دوباره نمی‌شمارد. مبالغ در انتظار، بدهی تأییدشده نیستند. ثبت‌های رد یا لغوشده در جمع سهم ندارند. جزئیات خالیِ بررسی‌کننده ثبت نشده‌اند. نام‌ها نام حساب‌اند، نه هویت حقوقی تأییدشده.",
  "export.record.acknowledgedBalance": "باقی‌ماندهٔ خالص تأییدشده",
  "export.record.pendingBalance": "تغییر خالصِ در انتظار",
  "export.record.privateBalance": "باقی‌ماندهٔ خالص خصوصی",
  "export.record.contribution": "سهم در باقی‌مانده",
  "export.record.status": "وضعیت ثبت",
  "export.record.pending": "در انتظار",
  "export.record.accepted": "پذیرفته شده",
  "export.record.rejected": "رد شده",
  "export.record.cancelled": "لغو شده",
  "export.record.private": "ثبت خصوصی",
  "export.record.sync": "وضعیت همگام‌سازی",
  "export.record.awaitingSync": "در انتظار همگام‌سازی",
  "export.record.acceptanceAwaitingSync": "پذیرش در انتظار همگام‌سازی",
  "export.record.rejectionAwaitingSync": "رد در انتظار همگام‌سازی",
  "export.record.cancellationAwaitingSync": "لغو در انتظار همگام‌سازی",
  "export.record.saved": "در سرور ثبت شده",
  // نمبر, as export.col.id above: شناسه is Iranian register.
  "export.record.tabId": "نمبر حساب مشترک",
  "export.record.author": "ثبت‌کننده",
  "export.record.authorId": "نمبر حساب ثبت‌کننده",
  "export.record.authorRole": "نقش ثبت‌کننده در آن زمان",
  "export.record.recordedAt": "زمان ثبت (UTC)",
  "export.record.reviewer": "بررسی‌کننده",
  "export.record.reviewerId": "نمبر حساب بررسی‌کننده",
  "export.record.reviewerParty": "طرف بررسی‌کننده",
  "export.record.reviewerRole": "نقش بررسی‌کننده در آن زمان",
  "export.record.reviewedAt": "زمان بررسی (UTC)",
  "export.record.reviewVersion": "نسخهٔ عمل بررسی",
  "export.record.reason": "دلیل رد",
  "export.record.cancelledBy": "لغوکننده",
  "export.record.cancelledById": "نمبر حساب لغوکننده",
  "export.record.cancelledAt": "زمان لغو (UTC)",
  "export.record.cancellationId": "نمبر ثبت لغو",
  "export.record.seq": "ترتیب ثبت",
  "export.record.rev": "نسخهٔ ثبت",
  "export.record.unknown": "ثبت نشده",
  "export.record.closedDeleted":
    "به دلیل حذف یک حساب بسته شده است. سابقهٔ مشترک فقط قابل خواندن است.",
  "export.record.archiveTitle": "دورهٔ مشترک پیشین",
  "export.preLinkHistory.title": "سابقهٔ غیرمشترک پیش از پیوند",
  "export.preLinkHistory.note":
    "فقط برای حفظ سابقه است. باقی‌ماندهٔ این ثبت‌ها در ثبت آغازین انتقال یافته و در مجموع فعلی جمع نمی‌شود.",
  "export.record.beforeLink": "پیش از پیوند — بیرون از باقی‌ماندهٔ فعلی",
  "export.record.archiveExplanation":
    "فقط برای حفظ سابقه است. این دوره در باقی‌ماندهٔ فعلی جمع نمی‌شود؛ مبلغ انتقال‌یافتهٔ آن در ثبت آغازینِ دورهٔ بعد آمده است. باقی‌ماندهٔ این بخش مربوط به همان حساب پیشین است.",
  "export.record.scope": "محدودهٔ باقی‌مانده",
  "export.record.current": "صورت‌حساب فعلی",
  "export.record.archived": "دورهٔ مشترک پیشین — بیرون از باقی‌ماندهٔ فعلی",
  "export.record.currency": "واحد پول",
  "export.record.periodBalance": "باقی‌ماندهٔ دورهٔ پیشین",
  "export.record.recordedAmount": "مبلغ ثبت‌شده",
  "export.record.role.account": "صاحب حساب",
  "export.record.side.this": "این طرف",
  "export.record.side.other": "طرف مقابل",

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
  // --- App health / diagnostics ---
  // "وضعیت برنامه" matches what preferences.diagnostics.row and
  // account.appHealth.section already call this destination, so the row a user
  // taps and the screen it opens use the same words.
  "diagnostics.title": "وضعیت برنامه",
  "diagnostics.hint":
    "مشکلی وجود دارد؟ روی «ارسال به پشتیبانی» بزنید — واتساپ با همین گزارش آماده باز می‌شود تا ببینیم چه شده و آن را درست کنیم. یا آن را کپی کنید و خودتان بفرستید.",
  "diagnostics.copyReport": "کپی گزارش",
  "diagnostics.copying": "در حال کپی…",
  "diagnostics.copied": "کپی شد ✓",
  "diagnostics.sendToSupport": "ارسال به پشتیبانی",
  "diagnostics.support.intro": "سلام کاتا — برنامه مشکل دارد. این گزارش وضعیت برنامهٔ من است.",
  "diagnostics.toast.copied": "کپی شد — حالا آن را در واتساپ برای ما بفرستید",
  "diagnostics.toast.copyFailed": "کپی خودکار نشد — متن پایین را کپی کنید",
  "diagnostics.toast.sendFailed": "واتساپ باز نشد — گزارش را کپی کنید و برای ما بفرستید",
  "diagnostics.fallbackHint":
    "روی متن پایین فشار دهید → همه را انتخاب کنید → کپی، بعد آن را برای ما بفرستید.",
  "diagnostics.section.version": "نسخه",
  "diagnostics.staleBuild":
    "⚠ نسخهٔ جاواسکریپت {js} با نسخهٔ نصب‌شده {native} فرق دارد — بیلد کهنه است؛ آخرین نسخه را دوباره نصب کنید.",
  "diagnostics.section.exits": "چرا برنامه بسته شد (تازه‌ترین اول)",
  "diagnostics.noExits": "سابقه‌ای ثبت نشده (اندروید کمتر از ۱۱، یا نصب تازه).",
  "diagnostics.section.now": "همین حالا",
  "diagnostics.refresh": "تازه‌سازی",

  // Mutual tab — حساب مشترک. Afghan register throughout (کاتا, دکان, لینک
  // as shopkeepers say it); "پیوند" for link-as-verb, "لینک" for the URL.
  "tab.link.title": "پیوند با کاتای او",
  "tab.link.action": "ساختن حساب مشترک",
  "tab.link.confirm.title": "این حساب مشترک شود؟",
  "tab.link.confirm.body":
    "{name} همهٔ ثبت‌های این حساب را می‌بیند و می‌تواند ثبت اضافه کند، قبول کند یا رد کند. ثبت‌های ردشده در ماندهٔ حساب حساب نمی‌شوند. باقی‌ماندهٔ فعلی به شکل یک ثبت آغازین قابل دید منتقل می‌شود.",
  "tab.link.confirm.ok": "پیوند",
  "tab.link.whatsapp": "پیوند و باز کردن واتساپ",
  "tab.link.ready": "دعوت‌نامه آماده است",
  "tab.link.readyBody": "این دعوت‌نامه را به {name} بفرستید تا از برنامهٔ کاتای خود بپیوندد.",
  "tab.link.inviteUnavailable":
    "این حساب قبلاً پیوند شده است. فقط طرفی که آن را ایجاد کرده می‌تواند دعوت‌نامه را بفرستد.",
  "tab.link.failed": "پیوند برقرار نشد. انترنت را بررسی کنید و دوباره امتحان کنید.",
  "tab.link.sent": "لینک فرستاده شد",
  "tab.opening.note": "باقی‌مانده پیش از پیوند",
  "tab.share.whatsapp": "فرستادن لینک در واتساپ",
  "tab.share.copy": "کپی لینک",
  "tab.copied": "لینک کپی شد",
  "tab.share.again": "فرستادن دوبارهٔ لینک",
  "tab.regenerate": "لینک نو (لینک قبلی از کار می‌افتد)",
  "tab.regenerate.title": "لینک نو ساخته شود؟",
  "tab.regenerate.body":
    "لینکی که پیشتر فرستادید برای همه از کار می‌افتد. لینک نو را به {name} بفرستید.",
  "tab.regenerate.ok": "لینک نو",
  "tab.unlink": "قطع پیوند",
  "tab.unlink.title": "پیوند با {name} قطع شود؟",
  "tab.unlink.body":
    "پس از همگام‌سازی، هیچ‌کدام‌تان نمی‌توانید ثبت مشترک نو اضافه کنید یا از این حساب اعلان بفرستید. ثبت‌های پذیرفته‌شده و ماندهٔ تأییدشده محفوظ می‌مانند. ثبت‌های در انتظار هنوز طبق همان قواعد قابل بررسی یا لغو هستند. ثبت‌های نو در کتاب خودتان شخصی هستند.",
  "tab.unlink.pending":
    "قطع پیوند در انتظار همگام‌سازی است. برای توقف اشتراک در هر دو تلفون به اینترنت وصل شوید.",
  "tab.history.pending":
    "پیش از پیوند دوباره، ثبت‌های در انتظار دورهٔ مشترک قبلی را بررسی و همگام کنید.",
  "tab.history.changed":
    "تاریخچهٔ مشترک تغییر کرده است. آن را تازه کنید و پیش از پیوند دوباره ماندهٔ آغازین را بررسی کنید.",
  "tab.history.openingRequired":
    "این طرف هنوز ماندهٔ مشترک تأییدشده دارد. پیوند دوباره به ماندهٔ آغازینی نیاز دارد که طرف دیگر بتواند بررسی کند.",
  "tab.balance.confirmed": "ماندهٔ تأییدشدهٔ مشترک: {amount} {currency}",
  "tab.balance.pending": "{count} در انتظار · تغییر خالص {amount} {currency}",
  "tab.unlinked": "پیوند قطع شد",
  "tab.chip.linked": "پیوند شده · {name}",
  "tab.chip.waiting": "لینک فرستاده شد · در انتظار",
  "tab.beforeLinking": "پیش از پیوند · {count}",
  "tab.notSent": "فرستاده نشد · {count}",
  "tab.notSent.body":
    "این ثبت‌ها به حساب مشترک افزوده نشدند. برای بررسی شما در این تلفون نگه‌داری شده‌اند و در ماندهٔ حساب شامل نیستند.",
  "tab.status.new": "نو",
  "auth.redirect.title": "برای ادامه وارد شوید",
  "auth.redirect.subtitle": "با حساب کاتای خود وارد شوید. کاتاهای قبلی شما خودکار بازیابی می‌شوند.",
  "tab.status.accepted": "پذیرفته شده",
  "tab.feedback.accepted": "ثبت ({amount}) پذیرفته شد.",
  "tab.feedback.rejected": "ثبت ({amount}) رد شد و در بیلانس حساب نمی‌شود.",
  "tab.feedback.manyAccepted": "{count} ثبت پذیرفته شد.",
  "tab.feedback.manyRejected": "{count} ثبت رد شد و در بیلانس حساب نمی‌شود.",
  "tab.feedback.mixed": "{accepted} پذیرفته شد، {rejected} رد شد. ثبت‌های ردشده حساب نمی‌شوند.",
  "tab.status.pending": "در انتظار",
  "tab.status.disputed": "رد شده",
  "tab.status.voided": "باطل",
  "tab.status.sending": "در حال ارسال…",
  "tab.addedBy": "ثبت‌شده توسط {name}",
  "tab.addedByYou": "ثبت‌شده توسط شما",
  "tab.disputedReason": "رد شده: {reason}",
  "tab.void": "باطل کردن",
  "tab.cancel": "لغو ثبت",
  "tab.void.title": "این ثبت باطل شود؟",
  "tab.void.body":
    "ثبت با خط خورده دیده می‌شود و دیگر حساب نمی‌شود. اگر مقدار غلط بود، یک ثبت نو اضافه کنید.",
  "tab.voided": "ثبت باطل شد",
  "tab.accept": "تأیید",
  "tab.accepted": "تأیید شد",
  "tab.rejectedHint": "در ماندهٔ حساب حساب نمی‌شود.",
  "tab.reviewFinal": "این ثبت قبلاً پذیرفته یا رد شده است. برای تلاش دوباره، یک ثبت جدید بفرستید.",
  "tab.reject": "رد کردن",
  "tab.dispute": "افزودن دلیل…",
  "tab.dispute.title": "دلیل رد · {amount}",
  "tab.dispute.reasonLabel": "مشکل چیست؟",
  "tab.dispute.reasonPlaceholder": "مثلاً 300 دادم، نه 500",
  "tab.dispute.reasonRequired": "دلیلی بنویسید تا {name} بفهمد.",
  "tab.dispute.reasonTooLong": "کمتر از 300 حرف بنویسید.",
  "tab.dispute.send": "فرستادن دلیل",
  "tab.dispute.notFound": "این ثبت دیگر در حساب مشترک نیست.",
  "tab.disputed": "رد شد — از ماندهٔ حساب حذف شد",
  "tab.closed": "این حساب مشترک بسته شده است.",
  "tab.closedNote":
    "اشتراک در {date} متوقف شد. ثبت‌های تأییدشده محفوظ‌اند و ثبت‌های در انتظار هنوز قابل بررسی هستند. ثبت‌های تازه اینجا شخصی هستند.",
  "tab.settle.confirm":
    "بیلانس بررسی‌شده با {name} صفر است. این ثبت‌ها به سابقهٔ مشترک هر دوی شما منتقل و صفحهٔ تازه باز شود؟ ثبت‌ها محفوظ می‌مانند و می‌توانید از همین حساب مشترک استفاده کنید.",
  "tab.settle.pending": "پیش از صاف‌کردن حساب، همهٔ ثبت‌های در انتظار را بررسی و همگام کنید.",
  "tab.settle.changed": "سابقهٔ مشترک تغییر کرده است. آن را بررسی کنید و دوباره کوشش کنید.",
  "tab.settle.failed": "حساب مشترک صاف نشد. به اینترنت وصل شوید و دوباره کوشش کنید.",
  "tab.settle.history": "صاف‌شده توسط {name} · {date}",
  "tab.reviewedBy": "بررسی‌کننده: {name}",
  "tab.cancelledBy": "لغوکننده: {name}",
  "tab.needsConnection": "برای ثبت در حساب مشترک آنلاین شوید.",
  "tab.editLocked":
    "ثبت‌های مشترک ویرایش نمی‌شوند. ثبت در انتظار خودتان را می‌توانید لغو کنید؛ اصلاح ثبت پذیرفته‌شده به یک ثبت نو نیاز دارد.",
  "tab.currencyLocked": "پیش از تغییر ارز، پیوند حساب‌های مشترک را قطع کنید.",
  "tab.duplicateHint": "پیشتر توسط {name} ثبت شده — بررسی کنید دو بار حساب نشود.",
  "tab.them": "او",
  "tab.row.pending": "{count} برای بررسی",
  "tab.row.awaiting": "{count} در انتظار تأیید",
  "tab.row.notDownloaded": "حساب مشترک هنوز دانلود نشده",
  "tab.notDownloaded":
    "این حساب مشترک هنوز روی این تلفن دانلود نشده است. بیلانس آن پس از دانلود نمایش داده می‌شود؛ اگر همین‌طور ماند، اتصال انترنت را بررسی کنید.",
  "tab.invite.message":
    "{name} یک حساب کاتا را با شما شریک کرده است. لینک را باز کنید تا باقی‌مانده را ببینید و ثبت اضافه یا تأیید کنید:\n{url}",
  "tab.join.title": "حساب مشترک",
  "tab.join.from": "{name} یک حساب مشترک با شما دارد",
  "tab.join.balanceLabel": "باقی‌مانده",
  "tab.join.entries": "{count} ثبت",
  "tab.join.join": "پیوستن",
  "tab.join.pickKaata": "این حساب برای کدام کاتا است؟",
  "tab.join.pickContact": "{name} در کاتای شما کیست؟",
  "tab.join.newContact": "مخاطب نو",
  "tab.join.noCurrencyKaata": "برای این حساب به یک کاتا به {currency} ضرورت دارید.",
  "tab.join.createKaata": "ساختن کاتا به {currency}",
  "tab.join.done": "با {name} پیوند شد",
  "tab.join.closed": "این حساب مشترک بسته شده است.",
  "tab.join.notFound": "این لینک دیگر معتبر نیست.",
  "tab.join.currencyMismatch": "کاتای شما به {kaata} است؛ این حساب به {tab} است.",
  "tab.join.sameKaata": "حساب مشترک با کاتای خودتان ساخته نمی‌شود.",
  "tab.join.sameAccount":
    "شما همین حالا در طرف دیگرِ این حساب مشترک هستید (کاتای خودتان است یا عضو آن هستید). با یک حساب دیگر وارد شوید.",
  "tab.join.alreadyLinked": "این مخاطب از قبل یک حساب مشترک دارد.",
  "tab.join.currencyNotSynced":
    "تغییر ارز کاتای شما هنوز به سرور نرسیده است. اتصال انترنت را بررسی کنید و دوباره تلاش کنید.",
  "tab.join.currencyIntro": "کاتای شما به {kaata} است. این حساب مشترک به {tab} است.",
  "tab.join.switchCurrency": "تغییر {name} به {currency}",
  "tab.join.switchEmptyHint": "هنوز ثبتی ندارد، پس چیزی تغییر نمی‌کند.",
  "tab.join.switchRelabelHint": "مبالغ موجود به {currency} نشان داده می‌شوند و تبدیل نمی‌شوند.",
  "tab.join.lockedByTab": "به خاطر یک حساب مشترک به {currency} قفل است",
  "tab.join.lockedByRole": "فقط مالک یا مدیر می‌تواند ارز این کاتا را تغییر دهد",
  "tab.join.createSeparate": "ساختن یک کاتای جداگانه به {currency}",
  "tab.join.orPick": "یا یک کاتا را به {currency} تغییر دهید",
  "tab.join.switchConfirmTitle": "{name} به {currency} تغییر کند؟",
  "tab.join.currencyPreset":
    "این حساب مشترک از {currency} استفاده می‌کند. کاتا به همین ارز ساخته می‌شود.",
  "tab.join.suggestTitle": "با شماره‌ای که این دعوت از آن آمده مطابقت دارد",
  "tab.join.suggestFromPhone": "از مخاطبین تلفن شما",
  "tab.join.suggestFromInvite": "از دعوت‌نامه",
  "tab.join.suggestWillCreate": "به کاتا و مخاطبین تلفن شما اضافه می‌شود",
  "tab.join.suggestWillAdd": "به کاتای شما اضافه می‌شود",
  "tab.join.linkTo": "پیوند می‌خورد با",
  "tab.join.chooseElse": "انتخاب کس دیگری",
  "tab.join.joinAs": "پیوند با {name}",
  "tab.join.searchContacts": "جستجوی مخاطبین",
  "tab.join.inKaata": "در کاتای شما",
  "tab.join.switched": "{name} حالا از {currency} استفاده می‌کند",
  "tab.notify.channel": "حساب‌های مشترک",
  "tab.notify.channelDescription":
    "ثبت‌هایی که طرف مقابل هنگام بسته بودن کاتا اضافه یا بررسی کرده است.",
  "tab.notify.fallbackTitle": "حساب مشترک",
  "tab.notify.newEntries": "{count} ثبت نو برای بررسی",
  "tab.notify.reviewed": "ثبت‌های شما بررسی شد",
  "tab.notify.accepted": "ثبت شما قبول شد.",
  "tab.notify.rejected": "ثبت شما رد شد و دیگر در ماندهٔ حساب حساب نمی‌شود.",
  "tab.notify.voided": "یک ثبت در حساب مشترک لغو شد.",
  "tab.notify.actionFailed": "پاسخ شما فرستاده نشد. برای بررسی، کاتا را باز کنید.",
};

// Pashto. Complete key coverage is enforced against the English source table.
const ps: Record<Key, string> = {
  "onboarding.subtitle": "ستاسو او د هغو خلکو ترمنځ یوه شخصي کاټه چې باور پرې لرئ.",
  "onboarding.name.label": "ستاسې نوم",
  "onboarding.name.placeholder": "سلطان",
  "onboarding.lastName.label": "تخلص",
  "onboarding.lastName.placeholder": "احمدي",
  "onboarding.phone.label": "د ټیلیفون شمېره",
  "onboarding.phone.required": "د ټیلیفون شمېره اړینه ده",
  "onboarding.phone.hint": "د وسیلو د نښلولو پر مهال ستاسې له ډلې سره مرسته کوي چې تاسې ومومي.",
  "onboarding.continue": "دوام ورکړئ",
  "onboarding.nameRequired": "نوم اړین دی",
  "recovery.selfPlaceholderName": "تاسې",
  "onboardingLanguage.title": "خپله ژبه غوره کړئ",
  "onboardingLanguage.subtitle": "خپله خوښه ژبه غوره کړئ. وروسته یې د حساب په برخه کې بدلولی شئ.",
  "onboardingMode.title": "له Kaata سره پیل وکړئ",
  "onboardingMode.subtitle": "غوره کړئ چې خپل حسابونه څنګه خوندي کړئ او لاسرسی ورته ولرئ.",
  "onboardingMode.account.label": "له کارن حساب سره",
  "onboardingMode.account.body":
    "د خپلو کاټو شاتړ واخلئ، په نوي ټیلیفون کې یې بېرته راوړئ او په خپلو بېلابېلو وسیلو کې یې وکاروئ.",
  "onboardingMode.google.title": "د Google له لارې ننوځئ",
  "onboardingMode.apple.title": "د Apple له لارې ننوځئ",
  "onboardingMode.offline.label": "د نینجا حالت",
  "onboardingMode.offline.body":
    "په سیورو کې پاتې شئ. کارن حساب ته اړتیا نشته. خپله کاټه په همدې ټیلیفون کې وساتئ او د کلاوډ شاتړ لپاره وروسته ننوځئ.",
  "onboardingMode.offline.title": "د نینجا په حالت کې دوام ورکړئ",
  "onboardingMode.offline.warning":
    "د نینجا په حالت کې د کارن حساب شاتړ نشته. که دا ټیلیفون ورک کړئ، ښايي خپل ټول معلومات له لاسه ورکړئ. د شاتړ لپاره وروسته ننوتلی شئ.",
  "onboardingMode.signInFailed": "ننوتل بریالي نه شول. بیا هڅه وکړئ.",
  "onboardingMode.signInFailed.network":
    "د ننوتلو پر مهال له Kaata سره اړیکه ټینګه نه شوه. خپل انټرنېټ وګورئ او بیا هڅه وکړئ.",
  "onboardingMode.signInFailed.playServices":
    "دا ټیلیفون د ننوتلو لپاره د Google Play Services نوې نسخې ته اړتیا لري. په Play Store کې یې نوې کړئ، یا پرته له کارن حسابه دوام ورکړئ.",
  "onboardingMode.expoGoHint":
    "ننوتل په اصلي اپ کې کار کوي؛ اوس د نینجا په حالت کې دوام ورکولی شئ.",
  "onboardingMode.back": "شاته",
  "onboardingMode.email.title": "د برېښنالیک له لارې دوام ورکړئ",
  "onboardingProfile.title": "ستاسې پېژندپاڼه",
  "onboardingProfile.subtitle":
    "له هغو کسانو سره مرسته وکړئ چې ګډ حسابونه ورسره لرئ، څو تاسې وپېژني.",
  "onboardingProfile.signedInHint": "د {email} په حساب ننوتلي یاست",
  "onboardingProfile.continue": "دوام ورکړئ",
  "onboardingProfile.nameRequired": "خپل نوم ولیکئ",
  "onboardingProfile.shopRequired": "خپلې کاټې ته نوم ورکړئ",
  "onboardingProfile.joinExisting": "له مخکې شته کاټې سره یوځای کېږم",
  "onboardingKaata.title": "خپلې کاټې ته نوم ورکړئ",
  "onboardingKaata.subtitle":
    "کاټه د ټولو حسابونه په یوه ځای کې ساتي. د خپل دوکان یا کور لپاره نوم ورکړئ.",
  "onboardingKaata.name.label": "د کاټې نوم",
  "onboardingKaata.name.placeholder": "د احمد خوراکي توکو دوکان",
  "onboardingKaata.name.required": "خپلې کاټې ته نوم ورکړئ",
  "onboardingKaata.currency.label": "اسعار",
  "onboardingKaata.currency.hint":
    "د نویو راکړو ورکړو اصلي اسعار. په همدې کاټه کې نور اسعار هم کارولی شئ.",
  "onboardingKaata.submit": "زما کاټه جوړه کړئ",
  "onboardingSuccess.title": "ستاسې کاټه چمتو ده",
  "onboardingSuccess.body":
    "یو کس ورزیات کړئ، بیا چې څه ورکوئ یا ترلاسه کوئ، ثبت یې کړئ. Kaata مو پاتې حساب ساتي.",
  "onboardingSuccess.ledgerLabel": "ستاسې کاټه",
  "onboardingSuccess.cta": "زما کاټه پرانیزئ",
  "guide.title": "کاټه څنګه کار کوي",
  "guide.p1": "کاټه ستاسې د دوکان د حساب کتابچه ده. یوه کاټه د یوه دوکان ټول حسابونه ساتي.",
  "guide.p2":
    "هر کس چې حساب ورسره لرئ، که پېرودونکی وي یا توکي دررسوونکی، ستاسې په کاټه کې یو حساب لري. د ښي لوري لاندې تڼۍ په وهلو یې ورزیات کړئ.",
  "guide.p3":
    "د کس په حساب کې، چې پیسې یا توکي ورکوئ «ورکړل» ثبت کړئ، او چې پیسې بېرته درکوي «ترلاسه کړل» ثبت کړئ. پاتې حساب په خپله بدلېږي.",
  "guide.p4":
    "له یوه ډېر دوکان چلوئ؟ بله کاټه جوړه کړئ. د کور پاڼې په سر کې د کاټې پر نوم په ټک کولو د کاټو ترمنځ اوښتی شئ.",
  "onboardingRestore.title": "بېرته ښه راغلاست",
  "onboardingRestore.checking": "ستاسې کاټې لټول کېږي",
  "onboardingRestore.checkingHint": "ستاسې په حساب کې خوندي شوي معلومات کتل کېږي.",
  "onboardingRestore.subtitleVaults": "ستاسې په حساب کې خوندي شوې کاټې: {count}",
  "onboardingRestore.restore.title": "له کلاوډ څخه بېرته راوړئ",
  "onboardingRestore.restore.bodyVaults":
    "خپل کسان، راکړې ورکړې او کاټې دې ټیلیفون ته بېرته راوړئ.",
  "onboardingRestore.fresh.title": "له سره پیل وکړئ",
  "onboardingRestore.fresh.body": "نوې کاټه جوړه کړئ. ستاسې خوندي شوې کاټې په کلاوډ کې پاتې کېږي.",
  "onboardingRestore.fresh.confirmTitle": "له تشې کاټې پیل کوئ؟",
  "onboardingRestore.fresh.confirmBody":
    "ستاسې د کاټو شاتړ په کلاوډ کې خوندي پاتې کېږي، خو اوس به دې ټیلیفون ته بېرته را نه وړل شي. وروسته د بېرته راوستلو لپاره بیا ننوتلی شئ.",
  "onboardingRestore.restoring": "ستاسې کاټه بېرته راوړل کېږي…",
  "onboardingRestore.tryAgain": "بیا هڅه وکړئ",
  "onboardingRestore.startFresh": "له سره پیل وکړئ",
  "onboardingRestore.errorTitle": "بېرته راوړل بریالي نه شول",
  "onboardingRestore.errorSessionExpired":
    "ستاسې د ننوتلو موده پای ته رسېدلې. د بېرته راوستلو لپاره بیا ننوځئ.",
  "onboardingRestore.signInAgain": "بیا ننوځئ",
  "onboardingRestore.errorTimeout": "انټرنېټ ډېر ورو و. له ښه انټرنېټ سره بیا هڅه وکړئ.",
  "onboardingRestore.errorGeneric": "ستونزه رامنځته شوه. بیا هڅه وکړئ.",
  "onboardingCalendar.title": "خپل کلیز غوره کړئ",
  "onboardingCalendar.subtitle":
    "هغه نېټې وکاروئ چې ورسره بلد یاست. وروسته یې د حساب په برخه کې بدلولی شئ.",
  "auth.email.signIn.title": "د برېښنالیک له لارې ننوځئ",
  "auth.email.signIn.subtitle": "د خپل Kaata حساب برېښنالیک یا کارن نوم او پټنوم وکاروئ.",
  "auth.email.identifier": "برېښنالیک یا کارن نوم",
  "auth.email.password": "پټنوم",
  "auth.email.signIn.submit": "ننوځئ",
  "auth.email.forgot": "پټنوم مو هېر شوی؟",
  "auth.email.toSignUp": "کارن حساب جوړ کړئ",
  "auth.email.toSignIn": "له مخکې کارن حساب لرئ؟ ننوځئ",
  "auth.email.signUp.title": "د Kaata کارن حساب جوړ کړئ",
  "auth.email.signUp.subtitle": "د پتې د تایید لپاره به یو 6 رقمي کوډ ستاسې برېښنالیک ته ولېږو.",
  "auth.email.email": "برېښنالیک",
  "auth.email.newPassword": "د Kaata پټنوم",
  "auth.email.newPassword.helper": "د Kaata لپاره نوی پټنوم جوړ کړئ، د خپل Gmail پټنوم مه کاروئ",
  "auth.email.sendCode": "کوډ ولېږئ",
  "auth.email.gmail": "د Google له لارې دوام ورکړئ: پټنوم ته اړتیا نشته",
  "auth.email.providerHint": "د Google یا Apple له لارې مو حساب جوړ کړی؟ هماغه تڼۍ وکاروئ.",
  "auth.email.code.title": "خپل برېښنالیک وګورئ",
  "auth.email.code.sent":
    "{email} ته مو یو 6 رقمي کوډ ولېږه. که په دې پته له مخکې د Kaata حساب وي، په برېښنالیک کې د ننوتلو لارښوونه شته.",
  "auth.email.code.label": "6 رقمي کوډ",
  "auth.email.code.spam": "له یوې دقیقې وروسته هم څه نه دي راغلي؟ د سپم پوښۍ وګورئ.",
  "auth.email.code.resend": "نوی کوډ ولېږئ",
  "auth.email.code.resendIn": "له {time} وروسته نوی کوډ ولېږئ",
  "auth.email.code.resent": "نوی کوډ درلېږل کېږي.",
  "auth.email.code.changeEmail": "برېښنالیک بدل کړئ",
  "auth.email.code.passwordAgain": "د Kaata هغه پټنوم بیا ولیکئ چې غوره کړی مو و.",
  "auth.email.code.submit": "کارن حساب جوړ کړئ",
  "auth.email.forgot.title": "خپل پټنوم بیا وټاکئ",
  "auth.email.forgot.subtitle":
    "هغه برېښنالیک ولیکئ چې پرې ننوځئ. که د Kaata پټنوم ولري، د بیا ټاکلو لپاره به کوډ ورولېږو.",
  "auth.email.backToSignIn": "د ننوتلو پاڼې ته ورشئ",
  "auth.email.reset.title": "نوی پټنوم غوره کړئ",
  "auth.email.reset.sent":
    "که {email} د Kaata پټنوم ولري، یو 6 رقمي کوډ مو ورلېږلی دی. کوډ او نوی پټنوم ولیکئ.",
  "auth.email.reset.newPassword": "نوی پټنوم",
  "auth.email.reset.submit": "خوندي کړئ او ننوځئ",
  "auth.email.required": "د خپل برېښنالیک پته ولیکئ.",
  "auth.email.identifierRequired": "خپل برېښنالیک یا کارن نوم ولیکئ.",
  "auth.email.passwordRequired": "خپل پټنوم ولیکئ.",
  "auth.email.codeRequired": "په برېښنالیک کې راغلی 6 رقمي کوډ ولیکئ.",
  "auth.password.show": "پټنوم وښایئ",
  "auth.password.hide": "پټنوم پټ کړئ",
  "auth.password.rule.length": "8 یا ډېر توري",
  "auth.password.rule.digits": "یوازې شمېرې مه کاروئ، مګر که 12 یا ډېرې وي",
  "auth.password.rule.runs": "د 123456 یا aaaaaa په څېر اسانه لړۍ مه کاروئ",
  "auth.password.rule.personal": "عام پټنوم یا خپل برېښنالیک مه کاروئ",
  "auth.error.email.format": "د برېښنالیک سمه پته ولیکئ، لکه name@example.com.",
  "auth.error.email.relay": "د Apple پټه منځګړې پته دلته نه شي کارېدلی. د خپل برېښنالیک پته ولیکئ.",
  "auth.error.email.disposable":
    "لنډمهاله برېښنالیک پتې نه شي کارېدلی. داسې پته ولیکئ چې تل یې کاروئ.",
  "auth.error.email.required": "د ننوتلو لپاره د برېښنالیک پته ولیکئ.",
  "auth.error.email.inUse": "د Kaata بل حساب دا برېښنالیک کاروي. بله پته ولیکئ.",
  "auth.error.password.too_short": "لږ تر لږه 8 توري وکاروئ.",
  "auth.error.password.too_long": "128 یا لږ توري وکاروئ.",
  "auth.error.password.whitespace": "د پټنوم له پیل یا پای څخه تشه لرې کړئ.",
  "auth.error.password.common": "دا پټنوم ډېر عام دی. داسې پټنوم غوره کړئ چې اټکل یې سخت وي.",
  "auth.error.password.personal": "خپل برېښنالیک، کارن نوم یا د ټیلیفون شمېره په پټنوم کې مه لیکئ.",
  "auth.error.password.pattern": "د 123456، aaaaaa یا یوازې شمیرو په څېر اسانه بڼې مه کاروئ.",
  "auth.error.password.weak": "پیاوړی پټنوم غوره کړئ.",
  "auth.error.code.invalid":
    "دا کوډ سم نه دی یا یې وخت تېر شوی. تر ټولو نوی برېښنالیک وکاروئ یا نوی کوډ ولېږئ.",
  "auth.error.accountExists": "په دې برېښنالیک له مخکې د Kaata حساب شته. خپل حساب ته ننوځئ.",
  "auth.error.invalidCredentials": "برېښنالیک، کارن نوم یا پټنوم سم نه دی.",
  "auth.error.wrongPassword": "ستاسې اوسنی پټنوم سم نه دی.",
  "auth.error.noPassword": "دا حساب لا د Kaata پټنوم نه لري.",
  "auth.error.passwordExists": "دا حساب له مخکې د Kaata پټنوم لري.",
  "auth.error.username.format":
    "له 3 تر 30 کوچني لاتین توري، شمېرې، _ یا . وکاروئ او په توري یې پیل کړئ.",
  "auth.error.username.reserved": "دا کارن نوم نه شي کارېدلی. بل غوره کړئ.",
  "auth.error.username.taken": "دا کارن نوم بل چا اخیستی. بل غوره کړئ.",
  "auth.error.name.invalid": "ستاسې نوم باید له 2 تر 60 توري ولري.",
  "auth.error.name.provider": "ستاسې نوم له Google یا Apple څخه اخیستل شوی.",
  "auth.error.tooManyAttempts": "هڅې ډېرې شوې. څو دقیقې تم شئ، بیا هڅه وکړئ.",
  "auth.error.tooManyAttempts.wait": "هڅې ډېرې شوې. له {time} وروسته بیا هڅه وکړئ.",
  "auth.error.tooManyEmails": "د دې برېښنالیک لپاره غوښتنې ډېرې شوې. لږ تم شئ، بیا هڅه وکړئ.",
  "auth.error.tooManyEmails.wait":
    "د دې برېښنالیک لپاره غوښتنې ډېرې شوې. له {time} وروسته بیا هڅه وکړئ.",
  "auth.error.rateLimited": "هڅې ډېرې شوې. څو دقیقې تم شئ، بیا هڅه وکړئ.",
  "auth.error.rateLimited.wait": "هڅې ډېرې شوې. له {time} وروسته بیا هڅه وکړئ.",
  "auth.error.emailUnavailable":
    "اوس د برېښنالیک کوډونه نه شي لېږل کېدای. Google یا Apple وکاروئ، یا وروسته بیا هڅه وکړئ.",
  "auth.error.busy": "Kaata بوخت دی. لږ وروسته بیا هڅه وکړئ.",
  "auth.error.accountDisabled": "دا حساب غیرفعال شوی دی.",
  "auth.error.accountDeletionExpired":
    "د بېرته راوستلو 30 ورځنۍ موده پای ته رسېدلې. دا حساب د تل لپاره ړنګېږي.",
  "auth.error.sessionExpired": "له حسابه وتلي یاست. بیا ننوځئ او بیا هڅه وکړئ.",
  "auth.error.emailFixed": "ستاسې پټنوم باید ستاسې د حساب له برېښنالیک پتې سره تړلی وي.",
  "auth.error.providerSessionRequired": "د پټنوم د لرې کولو لپاره د Google یا Apple له لارې ننوځئ.",
  "auth.error.tokenExpired": "ننوتلو ډېر وخت واخیست. بیا ننوځئ.",
  "auth.wait.seconds": "{n} ثانیې",
  "auth.wait.minute": "1 دقیقه",
  "auth.wait.minutes": "{n} دقیقې",
  "auth.wait.hour": "1 ساعت",
  "auth.wait.hours": "{n} ساعته",
  "auth.error.recoveryUnavailable":
    "حساب ته ننوتلي یاست، خو ستاسو کاټې بېرته راوګرځول نه شوې. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "accountPassword.title.set": "پټنوم وټاکئ",
  "accountPassword.title.change": "پټنوم بدل کړئ",
  "accountPassword.set.body":
    "د کاټې پټنوم ورزیات کړئ، څو په هر ټیلیفون کې د خپل برېښنالیک له لارې ننوځئ. لومړی به هغه پتې ته یو کوډ ولېږو.",
  "accountPassword.set.relayNote":
    "ستاسو د اپل حساب خپله برېښنالیک پته پټوي؛ نو داسې پته ولیکئ چې لاسرسی ورته لرئ.",
  "accountPassword.set.codeSent": "موږ {email} ته ۶ رقمي کوډ ولېږه. له خپل نوي پټنوم سره یې ولیکئ.",
  "accountPassword.set.submit": "پټنوم خوندي کړئ",
  "accountPassword.set.done": "پټنوم خوندي شو. اوس په {email} او دې پټنوم ننوتلی شئ.",
  "accountPassword.change.current": "اوسنی پټنوم",
  "accountPassword.change.body": "نور هغه ټیلیفونونه چې دې حساب ته ننوتلي دي، له حسابه ایستل کېږي.",
  "accountPassword.change.submit": "پټنوم بدل کړئ",
  "accountPassword.change.done": "پټنوم بدل شو. نور ټیلیفونونه له حسابه وایستل شول.",
  "accountPassword.loadFailed": "ستاسو حساب راوړل نه شو. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "accountPassword.set.fixedEmail": "موږ به {email} ته ۶ رقمي کوډ ولېږو.",
  "accountPassword.remove.title": "خپل پټنوم لرې کوئ؟",
  "accountPassword.remove.body":
    "یوازې د ګوګل یا اپل له لارې به ننوتلی شئ. په پټنوم ننوتلي ټیلیفونونه له حسابه ایستل کېږي.",
  "accountPassword.remove.cta": "پټنوم لرې کړئ",
  "accountPassword.remove.done": "پټنوم لرې شو",
  "accountUsername.title": "کارن‌نوم",
  "accountUsername.body":
    "کله چې په پټنوم ننوځئ، د خپل برېښنالیک پر ځای کارن‌نوم کارولی شئ. یوازې تاسو یې وینئ.",
  "accountUsername.rules":
    "له ۳ تر ۳۰ تورو: د انګلیسي واړه توري، شمېرې، _ او .؛ په توري دې پیل شي.",
  "accountUsername.save": "کارن‌نوم خوندي کړئ",
  "accountUsername.remove": "کارن‌نوم لرې کړئ",
  "accountUsername.saved": "کارن‌نوم خوندي شو",
  "accountUsername.removed": "کارن‌نوم لرې شو",
  "accountUsername.needsPassword": "لومړی پټنوم وټاکئ؛ کارن‌نوم یوازې له پټنوم سره کار کوي.",
  "auth.redirect.title": "د دوام لپاره ننوځئ",
  "auth.redirect.subtitle": "خپل کاټه حساب وکاروئ. پخوانۍ کاټې به مو په خپله بېرته راوګرځي.",
  "account.differentAccount.title": "په دې ټیلیفون کې بل کارن حساب شته",
  "account.differentAccount.body":
    "دا ټیلیفون له {oldEmail} سره تړلی دی. تاسې {newEmail} ته ننوځئ. څه کول غواړئ؟",
  "account.differentAccount.keep": "حساب بدل کړئ، زما معلومات وساتئ",
  "account.differentAccount.wipe": "حساب بدل کړئ، له سره پیل وکړئ",
  "account.differentAccount.cancel": "لغوه کړئ",
  "preferences.title": "غوراوي",
  "preferences.currency.section": "اسعار",
  "preferences.currency.defaultHint":
    "د نویو کاټو لپاره کارېږي. هره کاټه یې په جلا توګه بدلولی شي.",
  "preferences.region.section": "سیمه",
  "preferences.country.label": "له مخکې ټاکل شوی هېواد",
  "preferences.country.hint":
    "د نویو اړیکو د هېواد ټاکنه له دې ځایه پیلېږي. شته ټیلیفون شمېرې نه بدلوي.",
  "preferences.country.changed": "له مخکې ټاکل شوی هېواد بدل شو.",
  "preferences.appearance.section": "بڼه",
  "preferences.appearance.theme": "رنګیزه بڼه",
  "preferences.appearance.themeHint": "روښانه، تیاره، یا د سیستم له مخې.",
  "preferences.notifications.section": "خبرتیاوې",
  "preferences.notifications.reminders": "یادونې",
  "preferences.notifications.remindersHint": "د ناتادیه شویو پیسو په اړه خبرتیا ترلاسه کړئ.",
  "preferences.comingSoon": "ژر راځي",
  "preferences.diagnostics.section": "د ستونزو موندنه",
  "preferences.diagnostics.row": "د اپ حالت",
  "preferences.diagnostics.rowHint":
    "د حافظې او ناڅاپي بندېدو معلومات. که درڅخه وغوښتل شي، د پردې انځور واخلئ.",
  "settings.saved": "خوندي شول",
  "settings.language.label": "ژبه",
  "settings.language.option.system": "د ټیلیفون ټاکل شوې ژبه",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "ژبه بدله شوه.",
  "settings.calendar.label": "کلیز",
  "settings.calendar.option.auto": "په خپله",
  "settings.calendar.option.gregorian": "میلادي",
  "settings.calendar.option.jalali": "هجري لمریز",
  "settings.calendar.option.qamari": "هجري قمري",
  "settings.calendar.hint.qamari":
    "دا کلیز د محاسبې له مخې دی. که ستاسو د سپوږمۍ له لیدلو سره توپیر ولري، په حساب کې یې سم کړئ.",
  "settings.qamariOffset.label": "قمري نېټه سمه کړئ",
  "settings.qamariOffset.hint": "کله چې نېټه ستاسو د سپوږمۍ له لیدلو سره یوه ورځ توپیر ولري",
  "settings.qamariOffset.none": "بدلون نشته",
  "settings.qamariOffset.later1": "۱ ورځ وروسته",
  "settings.qamariOffset.later2": "۲ ورځې وروسته",
  "settings.qamariOffset.earlier1": "۱ ورځ مخکې",
  "settings.qamariOffset.earlier2": "۲ ورځې مخکې",
  "settings.qamariOffset.changed": "قمري نېټې سمې شوې",
  "settings.calendar.hint.auto": "ستاسو د ژبې له مخې ټاکل کېږي",
  "settings.calendar.changed": "کلیز بدل شو.",
  "settings.messageLang.label": "د پیغام ژبه",
  "settings.messageLang.hint": "د واټس‌اپ پیغامونو او د شریک حساب کتاب د لینک لپاره.",
  "settings.messageLang.option.auto": "د اپ ژبه",
  "settings.messageLang.option.ask": "هر ځل پوښتنه وکړئ",
  "settings.messageLang.changed": "د پیغام ژبه بدله شوه.",
  "settings.currency.label": "ټاکل شوې پیسه",
  "settings.currency.hint":
    "دا یوازې د مبلغونو د ښودلو د پیسې نوم بدلوي. پخوانۍ راکړې ورکړې بلې پیسې ته نه اړوي.",
  "settings.currency.changed": "پیسه بدله شوه.",
  "country.title": "هېواد وټاکئ",
  "currency.title": "د پیسو واحد وټاکئ",
  "currency.search": "په نوم، کوډ یا نښه یې ولټوئ",
  "currency.noMatch": "د پیسو واحد ونه موندل شو.",
  "currency.precisionHint": "کاتا اوس د دې پیسو واحد لپاره تر ۲ اعشاري ځایونو پورې ملاتړ کوي.",
  "country.search": "په نوم یا کوډ یې ولټوئ",
  "country.noMatch": "پایله ونه موندل شوه.",
  "updatePrompt.title": "تازه کول اړین دي",
  "updatePrompt.body":
    "ستاسو د کاټې نسخه د دوام لپاره ډېره پخوانۍ ده. د اپ د کارولو لپاره تر ټولو نوې نسخه نصب کړئ.",
  "updatePrompt.install": "v{version} نصب کړئ",
  "updatePrompt.installGeneric": "نوې نسخه نصب کړئ",
  "updatePrompt.openFailed": "د ښکته کولو لینک پرانیستل نه شو. kaata.af/download ته ورشئ.",
  "updateBanner.title": "نوې نسخه شته · v{version}",
  "updateBanner.cta": "تازه کړئ",
  "updateBanner.learnMore": "نور معلومات",
  "updateBanner.dismiss": "بند کړئ",
  "backupNag.title": "د خپل دوکان بیک‌اپ جوړ کړئ",
  "backupNag.body":
    "خپل حساب ته ننوځئ، څو د ټیلیفون د ورکېدو په صورت کې ستاسو د کارکوونکو ثبتونه خوندي پاتې شي.",
  "backupNag.cta": "د بیک‌اپ لپاره ننوځئ",
  "backupNag.dismiss": "بند کړئ",
  "account.title": "حساب",
  "account.profile.section": "ستاسو معلومات",
  "account.preferences.section": "غوره توبونه",
  "account.kaatas.section": "کاټې",
  "account.archived.row": "آرشیف شوې کاټې",
  "account.save": "بدلونونه خوندي کړئ",
  "account.signin.section": "ننوتل",
  "account.signin.email": "برېښنالیک",
  "account.signin.loginEmail": "په پټنوم ننوتل: {email}",
  "account.signin.password.set": "پټنوم وټاکئ",
  "account.signin.password.setHint": "په خپل برېښنالیک او پټنوم هم ننوځئ",
  "account.signin.password.change": "پټنوم بدل کړئ",
  "account.signin.password.remove": "پټنوم لرې کړئ",
  "account.signin.password.removeHint": "یوازې د ګوګل یا اپل له لارې ننوځئ",
  "account.signin.username": "کارن‌نوم",
  "account.signin.username.none": "نه دی ټاکل شوی",
  "account.signin.username.hint": "د ننوتلو پر مهال یې د برېښنالیک پر ځای وکاروئ",
  "account.signin.loading": "د ننوتلو معلومات راوړل کېږي…",
  "account.signin.failed": "د ننوتلو معلومات راوړل نه شول. د بیا هڅې لپاره ووهئ.",
  "account.signin.network": "له کاټې سره اړیکه ټینګه نه شوه. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "account.signin.error": "دا کار ونه شو. بیا هڅه وکړئ.",
  "account.appHealth.section": "د اپ حالت",
  "account.appHealth.details": "بشپړ تشخیصي معلومات",
  "account.appHealth.detailsHint": "د حافظې او ناڅاپي بندېدو معلومات",
  "account.privacy.section": "محرمیت او معلومات",
  "account.privacy.label": "د محرمیت تګلاره",
  "account.deleteAccount.label": "حساب ړنګ کړئ",
  "account.deleteAccount.hint": "په بیا ننوتلو سره د بېرته راګرځولو لپاره ۳۰ ورځې وخت لرئ",
  "account.deleteAccount.confirm.title": "خپل حساب ړنګوئ؟",
  "account.deleteAccount.confirm.body":
    "موږ به ستاسو د خوندي شوو راکړو ورکړو بیک‌اپ جوړ کړو، له حسابه به مو وباسو او د دې ټیلیفون معلومات به پاک کړو. ستاسو حساب او د کلاوډ معلومات به ۳۰ ورځې وساتل شي، بیا به د تل لپاره ړنګ شي. په ۳۰ ورځو کې بیا ننوځئ، څو ړنګول لغوه کړئ او هغه خوندي شوي کلاوډ معلومات بېرته را وګرځوئ چې لا هم لاسرسی ورته لرئ. شخصي یادونې او «نه دي لېږل شوې» مسودې یوازې په دې ټیلیفون کې دي او له منځه ځي؛ نو اړینې یې درسره ولیکئ. لومړی د پېرودونکي له مخ څخه د هغو شریکو حسابونو حسابپاڼې وباسئ چې نور ورته لاسرسی نه لرئ. پخوا د تل لپاره پاک شوي معلومات نه شي راګرځېدلی. نور ګډونوال د شریکو راکړو ورکړو تاریخچه ساتي. ړنګول پاتې حساب نه تصفیه کوي.",
  "account.deleteAccount.confirm.cta": "حساب ړنګ کړئ",
  "account.deleteAccount.preparing": "د بېرته راګرځولو کاپي خوندي کېږي…",
  "account.deleteAccount.backupFailed":
    "ړنګول بشپړ نه شول. د دې ټیلیفون معلومات وساتئ، خپله اړیکه وګورئ او له بیا هڅې مخکې همغږي بشپړه کړئ.",
  "account.deleteAccount.graceUnavailable":
    "د بېرته راګرځولو ساتنه تراوسه چمتو نه ده. ستاسو حساب او د دې ټیلیفون معلومات ساتل شوي دي. وروسته بیا هڅه وکړئ.",
  "account.deleteAccount.recovered": "ړنګول لغوه شول. ستاسو د کلاوډ کاټې بېرته راګرځېدلی شي.",
  "account.deleteAccount.lateEdits":
    "نوي بدلونونه په دې ټیلیفون کې خوندي ساتل شوي دي. په همدې حساب بیا ننوځئ، څو ړنګول لغوه کړئ او بیک‌اپ یې جوړ کړئ.",
  "account.deleteAccount.restoring": "ړنګول لغوه شول. ستاسو کاټې بېرته راګرځول کېږي…",
  "account.deleteAccount.failed": "ستاسو حساب ړنګ نه شو. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "account.deleteAccount.authRequired":
    "د خپل حساب له ړنګولو مخکې بیا ننوځئ. ستاسو د ټیلیفون حساب کتاب نه دی لرې شوی.",
  "account.retired.title": "د دې ټیلیفون حساب ړنګ شوی دی",
  "account.retired.body":
    "هغه حساب ړنګ شوی دی چې دا ټیلیفون وروستی ځل ورته ننوتلی و. ستاسو کاټې لا هم په دې ټیلیفون کې کار کوي. که حساب له ۳۰ ورځو څخه لږ مخکې ړنګ شوی وي، په هماغه حساب ننوځئ، څو ړنګول لغوه کړئ او هر څه بېرته ترلاسه کړئ. که نه، د بیا ننوتلو یا بیک‌اپ جوړولو لپاره لومړی خپل اړین معلومات وباسئ، بیا دا ټیلیفون د کاټې له پلوه له سره تنظیم کړئ. دا کار ټول هغه معلومات پاکوي چې کاټه یې په دې ټیلیفون کې ساتي.",
  "account.retired.pendingTitle": "د حساب ړنګول تر کار لاندې دي",
  "account.retired.pendingBody":
    "د دې ټیلیفون حساب به په {date} د تل لپاره ړنګ شي. تر هغې مخکې په همدې حساب ننوځئ، څو ړنګول لغوه کړئ او هر څه بېرته ترلاسه کړئ. تر هغه وخته ستاسو کاټې لا هم په دې ټیلیفون کې کار کوي.",
  "account.retired.signInCancel": "د ړنګولو د لغوه کولو لپاره ننوځئ",
  "account.retired.reset": "د دې ټیلیفون کاټه له سره تنظیم کړئ",
  "account.retired.confirm.title": "د دې ټیلیفون کاټه له سره تنظیموئ؟",
  "account.retired.confirm.body":
    "دا ټول هغه معلومات پاکوي چې کاټه یې په دې ټیلیفون کې ساتي، د هرې کاټې، هر کس او هرې راکړې ورکړې په ګډون. لومړی خپل اړین معلومات وباسئ. دا کار بېرته نه شي ګرځېدای.",
  "account.retired.confirm.cta": "پاک او له سره تنظیم کړئ",
  "account.retired.failed": "د دې ټیلیفون کاټه له سره تنظیم نه شوه. بیا هڅه وکړئ.",
  "selection.start": "غوره کړئ",
  "selection.contacts": "اړیکې غوره کړئ",
  "selection.tallies": "راکړې ورکړې غوره کړئ",
  "selection.count": "{count} غوره شوي",
  "selection.all": "ټول غوره کړئ",
  "selection.clear": "د ټولو ټاکنه لرې کړئ",
  "selection.allResults": "ټولې پایلې غوره کړئ",
  "selection.clearResults": "د پایلو ټاکنه لرې کړئ",
  "selection.close": "بشپړ شو",
  "selection.hint": "د دې توکي د غوره کولو یا د ټاکنې لرې کولو لپاره دوه ځله پرې ټک وکړئ.",
  "selection.removeContactsTitle": "{count} اړیکې لرې شي؟",
  "selection.removeContactsDescription":
    "دا اړیکې به په دې کاټه کې پټې شي. د «لرې شوي کسان» له برخې یې بېرته راوستلی شئ.",
  "selection.contactsRemoved": "{count} اړیکې لرې شوې",
  "selection.deleteTalliesTitle": "{count} راکړې ورکړې ړنګې شي؟",
  "selection.deleteTalliesDescription":
    "دا راکړې ورکړې به ړنګې او پاتې حسابونه به نوي شي. دا کار بېرته نه شي راګرځېدای.",
  "selection.talliesDeleted": "{count} راکړې ورکړې ړنګې شوې",
  "selection.partialFailure": "{count} توکي نوي نه شول. بیا هڅه وکړئ.",
  "selection.remove": "لرې کړئ",
  "selection.delete": "ړنګ کړئ",
  "selection.empty": "د توکو د غوره کولو لپاره پرې ټک وکړئ",
  "selection.summary.transactions": "{count} راکړې ورکړې",
  "selection.summary.transaction": "{count} راکړه ورکړه",
  "selection.summary.transactionsLabel": "راکړې ورکړې",
  "selection.summary.debt": "ټول ورکړل شوي",
  "selection.summary.credit": "ټول ترلاسه شوي",
  "selection.summary.remaining": "پاتې حساب",
  "selection.summary.collect": "د اخیستلو پاتې پیسې",
  "selection.summary.pay": "د ورکولو پاتې پیسې",
  "selection.summary.unavailable": "د ځینو غوره شویو حسابونو معلومات په دې ټیلیفون کې نشته.",
  "home.tab.collect": "د اخیستلو پیسې",
  "home.tab.pay": "د ورکولو پیسې",
  "home.total.label.collect": "د اخیستلو پیسې",
  "home.total.title": "بیلانسونه",
  "home.total.label.pay": "ورکونکې پیسې",
  "home.total.nextCurrency": "راتلونکی اسعار",
  "home.total.previousCurrency": "مخکینی اسعار",
  "home.total.pending": "ګډ حسابونه لا ډاونلوډېږي. ټولې پیسې به د چمتو کېدو وروسته ښکاره شي.",
  "home.empty.title": "تر اوسه پېرودونکي نشته",
  "home.empty.subtitle": "د حسابونو د ثبت پیل لپاره یو پېرودونکی ورزیات کړئ.",
  "home.empty.collect.title": "لا اخیستونکې پیسې نشته",
  "home.empty.collect.subtitle":
    "د ښي لوري لاندې تڼۍ ووهئ او د هغه کس حساب ورزیات کړئ چې حساب ورسره لرئ؛ د هر پېرودونکي لپاره یو حساب.",
  "home.empty.pay.title": "لا د چا پوروړي نه یاست",
  "home.empty.pay.subtitle":
    "چې توکي یا پیسې په پور اخلئ، د هماغه کس له پاڼې یې ثبت کړئ او دلته به ښکاره شي.",
  "home.from.someone": "له {count} کس څخه",
  "home.from.many": "له {count} کسانو څخه",
  "common.more": "نور",
  "common.less": "لږ",
  "readonly.badge": "یوازې کتل",
  "customers.listOptions": "ترتیب او چاڼ",
  "customers.search": "پېرودونکي ولټوئ",
  "search.openHint": "لټون او چاڼ له اړوندو پایلو سره پرانیزي.",
  "search.filters": "چاڼونه",
  "search.showResults": "پایلې وښایئ",
  "search.clearQuery": "لټون پاک کړئ",
  "search.clearAll": "ټول فلټرونه پاک کړئ",
  "customers.search.clear": "د پېرودونکو لټون پاک کړئ",
  "customers.search.title": "د لټون پایلې",
  "customers.search.result": "1 پېرودونکی وموندل شو",
  "customers.search.results": "{count} پېرودونکي وموندل شول",
  "customers.noResults": "اړوند پېرودونکي ونه موندل شول",
  "customers.noTallies": "لا حسابونه نشته",
  "customers.sort": "پېرودونکي ترتیب کړئ",
  "customers.sort.multiCurrencyHelp":
    "د مبلغ له مخې ترتیب هغه وخت شونی دی چې د بیلانسونو اسعار یو شان وي.",
  "customers.balanceFilter": "بیلانسونه",
  "customers.balanceFilter.all": "ټول پېرودونکي",
  "customers.balanceFilter.collect": "یوازې د اخیستلو پیسې",
  "customers.balanceFilter.pay": "یوازې د ورکولو پیسې",
  "customers.balanceFilter.help":
    "د ټولو اسعارو بیلانسونه کتل کېږي؛ یو پېرودونکی په دواړو فلټرونو کې راتلای شي.",
  "customers.balanceFilter.clear": "د بیلانس فلټر پاک کړئ",
  "customers.sort.outstanding_name": "لومړی ناتصفیه شوي حسابونه · د الفبا په ترتیب",
  "customers.sort.recent": "وروستي فعالیتونه",
  "customers.sort.name_asc": "نوم · د الفبا په ترتیب",
  "customers.sort.name_desc": "نوم · د الفبا په سرچپه ترتیب",
  "customers.sort.amount_desc": "پیسې · لومړی ډېرې",
  "customers.sort.amount_asc": "پیسې · لومړی لږې",
  "customers.sort.date_asc": "وروستۍ راکړه ورکړه · لومړی زړې",
  "customers.filtered":
    "{direction}: له {total} پېرودونکو څخه {shown} · د پورته ټولو پیسو له ډلې {amount}",
  "customers.noGroupResults": "په دې خوا کې د غوره شویو ډلو پېرودونکي نشته.",
  "home.fab.blockedArchived": "دا کاټه آرشیف شوې ده. بېرته یې را وګرځوئ یا بله وټاکئ.",
  "home.exit.hint": "د وتلو لپاره د بېرته تګ تڼۍ بیا ووهئ.",
  "home.loadFailed": "ستاسو د کاټې معلومات راوړل نه شول. ستاسو راکړې ورکړې خوندي دي؛ بیا هڅه وکړئ.",
  "home.noKaata.title": "تراوسه کاټې نشته",
  "home.noKaata.subtitle": "د حساب کتاب د پیل لپاره د خپل دوکان کاټه جوړه کړئ.",
  "home.noKaata.create": "کاټه جوړه کړئ",
  "home.noKaata.join": "له شته کاټې سره یوځای شئ",
  "home.noKaata.archived": "آرشیف شوې کاټې وګورئ ({count})",
  "common.cancel": "لغوه کړئ",
  "common.ok": "سمه ده",
  "menu.dev.bluetoothTest": "د بلوتوث ازموینه (پراختیا)",
  "common.back": "شاته",
  "common.refreshFailed": "معلومات تازه نه شول؛ خپله اړیکه وګورئ.",
  "common.retry": "بیا هڅه وکړئ",
  "common.done": "وشول",
  "common.close": "وتړئ",
  "common.hideKeyboard": "کیبورډ پټ کړئ",
  "common.loading": "راوړل کېږي…",
  "common.tryAgain": "بیا هڅه وکړئ",
  "common.removed": "{name} لرې شو",
  "common.remove": "لرې کړئ",
  "common.remove.title": "{name} لرې کړو؟",
  "common.remove.description":
    "ستاسو له لېست څخه به پټ شي. راکړې ورکړې یې ساتل کېږي؛ هر وخت یې د خپلې کاټې له تنظیماتو څخه بېرته راګرځولی شئ.",
  "common.notNow": "اوس نه",
  "common.backToKaata": "کاټې ته ستانه شئ",
  "common.signInToContinue": "د دوام لپاره ننوځئ",
  "person.action.iGave": "ورکړل",
  "person.action.iReceived": "ترلاسه کړل",
  "person.balance.theyOwe": "هغه ستاسې پوروړی دی",
  "person.balance.youOwe": "تاسې د هغه پوروړي یاست",
  "person.balance.settled": "حساب پاک دی",
  "person.balance.notSettled": "حساب نه دی پاک شوی",
  "person.empty.title": "لا راکړه ورکړه نشته",
  "person.empty.subtitle":
    "چې پیسې یا توکي ورکوئ «ورکړل» ووهئ، او چې یې ترلاسه کوئ «ترلاسه کړل» ووهئ.",
  "person.settle.row": "دا حساب تصفیه کړئ",
  "person.settle.confirm.title": "حساب تصفیه شي؟",
  "person.settle.confirm.body":
    "له {name} سره د دې حساب لاندې کرښه باسي. راکړې ورکړې د تصفیه شوي تاریخ په توګه ستاسې په کتابچه کې پاتې کېږي او راتلونکې راکړه ورکړه په نوې پاڼه پیلېږي.",
  "person.settle.confirm.cta": "کرښه وباسئ",
  "person.settle.done": "حساب تصفیه شو. نوې پاڼه.",
  "person.settle.failed": "حساب تصفیه نه شو. بیا هڅه وکړئ.",
  "person.settle.notZero": "د تصفیې لپاره باید پاتې حساب صفر وي.",
  "person.history.show": "{count} تصفیه شوي حسابونه · ټول وګورئ",
  "person.history.hide": "یوازې اوسنی حساب وښایئ",
  "person.history.settledOn": "تصفیه شوی · {date}",
  "person.freshChapter.title": "ټول حساب تصفیه شوی",
  "person.freshChapter.subtitle": "نوې پاڼه. پخوانی ګډ حساب مو لاندې ساتل شوی دی.",
  "person.ping.button": "د WhatsApp یادونه ولېږئ",
  "person.ping.hint": "پاتې حساب او وروستۍ راکړې ورکړې له {name} سره شریکې کړئ.",
  "person.ping.preparing": "ستاسې یادونه چمتو کېږي…",
  "person.ping.opening": "WhatsApp پرانیستل کېږي…",
  "person.search.placeholder": "یادښتونه یا پیسې ولټوئ",
  "person.search.clear": "لټون پاک کړئ",
  "person.date.title": "د نېټې له مخې چاڼ کړئ",
  "person.date.all": "ټولې نېټې",
  "person.date.today": "نن",
  "person.date.last7": "تېرې 7 ورځې",
  "person.date.last30": "تېرې 30 ورځې",
  "person.date.month": "دا میاشت",
  "person.date.custom": "د خوښې موده",
  "person.date.pickStart": "د پیل نېټه غوره کړئ",
  "person.date.pickEnd": "د پای نېټه غوره کړئ؛ د یوې ورځې لپاره پر هماغې ورځې بیا ټک وکړئ",
  "person.date.rangeReady": "د نوې مودې د پیل لپاره پر یوې نېټې ټک وکړئ",
  "person.date.chooseRange": "د مودې لپاره دوه نېټې غوره کړئ",
  "person.date.startTime": "د پیل وخت",
  "person.date.endTime": "د پای وخت",
  "person.date.invalidTimes":
    "سم وختونه غوره کړئ؛ د پای وخت باید د پیل له وخت سره برابر یا ترې وروسته وي.",
  "person.date.timeUnavailable": "د وخت ټاکونکی پرانیستل نه شو. بیا هڅه وکړئ.",
  "person.date.apply": "موده وکاروئ",
  "person.date.clear": "د نېټې چاڼ لرې کړئ",
  "person.date.active": "د نېټې چاڼ: {range}",
  "person.date.previousMonth": "تېره میاشت",
  "person.date.nextMonth": "راتلونکې میاشت",
  "person.date.weekday.0": "ی",
  "person.date.weekday.1": "د",
  "person.date.weekday.2": "س",
  "person.date.weekday.3": "چ",
  "person.date.weekday.4": "پ",
  "person.date.weekday.5": "ج",
  "person.date.weekday.6": "ش",
  "person.flows.allTime": "ټول وخت",
  "person.flows.gave": "ورکړل ({count})",
  "person.flows.received": "ترلاسه کړل ({count})",
  "person.flows.hint":
    "په شته تاریخ کې ثبت شوې ورکړې او ترلاسه شوې پیسې یا توکي. لومړني پاتې حسابونه نوې راکړې ورکړې نه شمېرل کېږي.",
  "person.search.result": "{count} اړونده راکړه ورکړه · په پاتې حساب کې ټولې راکړې ورکړې شاملې دي",
  "person.search.results": "{count} اړوندې راکړې ورکړې · په پاتې حساب کې ټولې راکړې ورکړې شاملې دي",
  "person.search.empty.title": "اړوندې راکړې ورکړې ونه موندل شوې",
  "person.search.empty.subtitle": "بل یادښت یا مبلغ ولټوئ، یا چاڼونه لرې کړئ.",
  "person.delete.title": "دا راکړه ورکړه ړنګه شي؟",
  "person.delete.description":
    "دا مبلغ نور د دې کس په پاتې حساب کې نه شمېرل کېږي. له دې ځایه یې بېرته نه شئ راګرځولی.",
  "person.delete.confirm": "ړنګ کړئ",
  "person.sheet.edit": "سم کړئ",
  "person.sheet.delete": "ړنګ کړئ",
  "person.row.noEntries": "لا راکړه ورکړه نشته",
  "person.row.settled": "حساب پاک دی",
  "personEdit.title": "د کس معلومات سم کړئ",
  "personEdit.name.label": "نوم",
  "personEdit.firstName.label": "نوم",
  "personEdit.lastName.label": "تخلص",
  "personEdit.phone.label": "د WhatsApp شمېره",
  "personEdit.save": "بدلونونه خوندي کړئ",
  "personAdd.title": "کس ورزیات یا پیدا کړئ",
  "personAdd.new": "کس ورزیات کړئ",
  "personFind.title": "کس پیدا کړئ",
  "personFind.placeholder": "د نوم یا شمېرې له مخې ولټوئ",
  "personFind.empty.subtitle": "دې کاټې ته ورزیات شوي کسان به دلته ښکاره شي.",
  "personAdd.firstName.placeholder": "احمد",
  "personAdd.lastName.placeholder": "کریمي",
  "personAdd.add": "{name} ورزیات کړئ",
  "personAdd.phone.hint": "په WhatsApp کې د یادونو لېږلو لپاره اړینه ده.",
  "personAdd.phone.invalid":
    "د ټاکل شوي هېواد د ټیلیفون شمېره ولیکئ، یا یې له + او د هېواد له کوډ سره ولیکئ.",
  "personAdd.phone.conflict": "دا شمېره له مخکې د {name} له خوا کارول کېږي",
  "personAdd.phone.isSelf": "دا ستاسې خپله شمېره ده — ځان نه شئ ورزیاتولی.",
  "personAdd.save.storageFull": "د ټیلیفون حافظه مو ډکه ده. لږ ځای تش کړئ او بیا هڅه وکړئ.",
  "personAdd.save.storageBusy": "Kaata د بدلونونو په خوندي کولو بوخت دی. لږ تم شئ او بیا هڅه وکړئ.",
  "personAdd.save.failed":
    "د دې کس خوندي کول بشپړ نه شول. Kaata بېرته پرانیزئ او بیا هڅه وکړئ. که ستونزه دوام وکړي، د «د اپ حالت» راپور شریک کړئ.",
  "personAdd.section.matches": "اړوندې پایلې",
  "personAdd.section.existing": "له مخکې په دې کاټه کې شته",
  "personAdd.section.recent": "وروستي",
  "personAdd.section.fromPhone": "ستاسې له ټیلیفون څخه",
  "personAdd.section.allContacts": "ټولې اړیکې",
  "personAdd.noMatch": "د «{query}» په نوم څوک ونه موندل شول.",
  "personAdd.empty.title": "دلته لا څوک نشته",
  "personAdd.empty.subtitle": "د لومړي کس د ورزیاتولو لپاره پورته یو نوم ولیکئ.",
  "personAdd.rightAmount.new": "نوی",
  "personAdd.rightAmount.settled": "حساب پاک دی",
  "personAdd.personNotFound": "کس ونه موندل شو.",
  "personAdd.phone.placeholderGeneric": "د ټیلیفون شمېره",
  "personAdd.contacts.allow":
    "د خپل ټیلیفون له اړیکو د کس د ورزیاتولو لپاره اړیکو ته د لاسرسي اجازه ورکړئ",
  "personAdd.contacts.openSettings": "په امستنو کې اړیکو ته لاسرسی فعال کړئ",
  "personAdd.contacts.manage": "په امستنو کې نورې اړیکې غوره کړئ",
  "personAdd.contacts.failed":
    "امستنې پرانیستل نه شوې. د ټیلیفون د امستنو له اپ څخه اړیکو ته د لاسرسي اجازه ورکولی شئ.",
  "personAdd.moreResults": "+{count} نور — د پایلو د کمولو لپاره لیکلو ته دوام ورکړئ",
  "personAdd.moreContacts": "د نورو اړیکو د موندلو لپاره نوم یا شمېره ولیکئ.",
  "contacts.title": "د ټیلیفون له اړیکو څخه وټاکئ",
  "contacts.search": "په نوم یې ولټوئ",
  "contacts.permission.title": "اړیکو ته د لاسرسي اجازه اړینه ده",
  "contacts.permission.body":
    "د دې لنډې لارې د کارولو لپاره د ټیلیفون تنظیمات پرانیزئ او کاټې ته خپلو اړیکو ته د لاسرسي اجازه ورکړئ.",
  "contacts.permission.button": "تنظیمات پرانیزئ",
  "contacts.empty.none": "په دې ټیلیفون کې اړیکې نشته.",
  "contacts.empty.noMatch": "له «{query}» سره سمون لرونکې اړیکه ونه موندل شوه.",
  "contacts.noPhone": "شمېره نشته",
  "contacts.loadFailed": "ستاسو اړیکې لوستل نه شوې. بیا هڅه وکړئ.",
  "person.ping.nudge": "{name} په واټس‌اپ خبر کړو؟",
  "person.ping.nudgeSend": "ولېږئ",
  "personEdit.export": "د حساب پاڼه صادره کړئ",
  "personEdit.exportFailed": "صادره نه شوه. بیا هڅه وکړئ.",
  "peopleRemoved.title": "لرې شوي کسان",
  "peopleRemoved.empty": "لرې شوي کسان نشته.",
  "peopleRemoved.emptySubtitle":
    "هغه کسان چې لرې یې کوئ، له خپلو راکړو ورکړو سره دلته پاتې کېږي او بېرته راوستلای یې شئ.",
  "peopleRemoved.emptyCta": "بېرته",
  "peopleRemoved.removedAt": "{relative} لرې شو",
  "peopleRemoved.entryCount": "{n} راکړې ورکړې",
  "peopleRemoved.entryCount.one": "1 راکړه ورکړه",
  "peopleRemoved.restoreButton": "بېرته راوګرځوئ",
  "peopleRemoved.restoredToast": "{name} بېرته ستاسو کاټې ته راغی",
  "peopleRemoved.restoreFailed": "بېرته راوستل نه شو. بیا هڅه وکړئ.",
  "peopleRemoved.relative.justNow": "همدا اوس",
  "peopleRemoved.relative.minutesAgo": "{n} دقیقې مخکې",
  "peopleRemoved.relative.hoursAgo": "{n} ساعته مخکې",
  "peopleRemoved.relative.daysAgo": "{n} ورځې مخکې",
  "peopleRemoved.relative.monthsAgo": "{n} میاشتې مخکې",
  "groups.filter": "ډلې",
  "groups.filterHelp": "ډلې غوره کړئ، څو د دې ډلو پېرودونکي ښکاره شي.",
  "groups.all": "ټول پېرودونکي",
  "groups.ungrouped": "بې ډلې",
  "groups.none": "هېڅ ډله نشته",
  "groups.manage": "ډلې تنظیم کړئ",
  "groups.help":
    "د دې کاټې لپاره خپلې ډلې جوړې کړئ. هر پېرودونکی په څو ډلو کې شاملېدای شي. ډلې لړلیک منظموي؛ د لاسرسي اجازه یا پاتې حسابونه نه بدلوي.",
  "groups.personAction": "د پېرودونکي ډلې",
  "groups.personHelp": "د دې پېرودونکي لپاره په دې کاټه کې یوه یا څو ډلې غوره کړئ.",
  "groups.members.help":
    "په دې ډله کې د پېرودونکو د شاملولو لپاره نښه پرې ولګوئ، او د ایستلو لپاره نښه لرې کړئ. بدلونونه د «بشپړ شو» په وهلو یا شاته تلو سره خوندي کېږي.",
  "groups.members.viewHelp": "په دې ډله کې پېرودونکي.",
  "groups.members.search": "پېرودونکي ولټوئ",
  "groups.members.none": "په دې ډله کې لا پېرودونکي نشته.",
  "groups.members.missing": "دا ډله نور نشته.",
  "groups.members.open": "ښيي چې څوک په دې ډله کې دي",
  "groups.memberCountOne": "{count} پېرودونکی",
  "groups.memberCount": "{count} پېرودونکي",
  "groups.edit": "{name} سم کړئ",
  "groups.empty": "لا ډلې نشته.",
  "groups.name": "د ډلې نوم",
  "groups.namePlaceholder": "لکه کورنۍ یا لوېدیځه محله",
  "groups.nameInvalid": "د ډلې لپاره له 1 تر 40 تورو نوم وکاروئ.",
  "groups.nameDuplicate": "په دې نوم له مخکې یوه ډله شته.",
  "groups.add": "ډله زیاته کړئ",
  "groups.rename": "د ډلې نوم بدل کړئ",
  "groups.archive": "ډله لرې کړئ",
  "groups.archiveTitle": "{name} لرې شي؟",
  "groups.archiveHelp":
    "پېرودونکي په خپلو نورو ډلو کې پاتې کېږي. راکړې ورکړې او پاتې حسابونه یې نه بدلېږي.",
  "groups.view": "ډله: {name}",
  "groups.viewMany": "ډلې: {name}",
  "groups.clearFilter": "بیا ټول پېرودونکي ښيي",
  "reminders.channel": "د پېرودونکو یادونې",
  "credit.title": "د پور حدونه",
  "credit.defaultTitle": "د پور عمومي حد",
  "credit.defaultHelp":
    "پر هر هغه پېرودونکي پلي کېږي چې خپل ځانګړی حد نه لري، په راتلونکي کې ورزیاتېدونکي پېرودونکي هم پکې شامل دي. د پېرودونکي خپل حد تل لومړیتوب لري.",
  "credit.usesDefault":
    "دا پېرودونکی خپل ځانګړی حد نه لري، نو د کاټې عمومي حد پرې پلي کېږي. دلته په خوندي کولو سره ورته ځانګړی حد ټاکئ.",
  "credit.defaultRow": "د پور عمومي حد",
  "credit.defaultRowHint": "د هغو پېرودونکو لپاره چې خپل حد نه لري",
  "credit.maxCollect": "تر ټولو ډېر پور چې هغوی یې زموږ پوروړي کېدای شي",
  "credit.maxPay": "تر ټولو ډېر پور چې موږ یې د هغوی پوروړي کېدای شو",
  "credit.unlimited": "حد نشته",
  "credit.warnMode": "یوازې خبرداری",
  "credit.hardMode": "پر مامورینو محدودیت ولګوئ",
  "credit.editorsMode": "پر سمون کوونکو او مامورینو محدودیت ولګوئ",
  "credit.modeHelp":
    "خبرداری یا محدودیت غوره کړئ. د غړو جلا اجازې بدلولی شي چې څوک باید حتمي حد مراعات کړي.",
  "credit.hardHelp":
    "هغه کارکوونکي چې حتمي حد پرې پلي کېږي، د هغو راکړو ورکړو لپاره چې د پور کچه بدلوي، انټرنېټي کتنې ته اړتیا لري. هغه راکړې ورکړې چې شته پور کموي، لا هم اجازه لري. مالک او مدیران له حدونو اوښتی شي؛ د غړو استثناوې یوازې پر حتمي حدونو پلي کېږي.",
  "credit.forCustomer": "د {name} لپاره",
  "credit.zeroHelp": "که حد نه غواړئ، ځای تش پرېږدئ. 0 په هغه لوري کې د هېڅ پور اجازه نه ورکوي.",
  "credit.loadFailed": "حدونه راوړل نه شول. شاته لاړ شئ او بیا یې پرانیزئ.",
  "credit.limitLeft": "حد {limit} · {left} پاتې",
  "credit.limitOver": "حد {limit} · {over} تر حد ډېر",
  "credit.clerksNeedSignIn":
    "د محدودیتونو له فعالولو مخکې، له هر اړوند کارکوونکي وغواړئ چې ننوځي او معلومات همغږي کړي.",
  "credit.warning": "دا راکړه ورکړه د پور له حده اوړي",
  "credit.blocked": "د پور له حده واوښت. دا راکړه ورکړه ثبت نه شوه.",
  "credit.pending": "د سرور تایید ته په تمه",
  "credit.pendingChange": "دا بدلون د سرور تایید ته په تمه دی. ثبت شوې راکړه ورکړه نه ده بدله شوې.",
  "credit.refusedChange":
    "دا بدلون رد شو، ځکه د پور له حده اوړي. ثبت شوې راکړه ورکړه نه ده بدله شوې.",
  "credit.intentEdit": "راکړه ورکړه سمه کړئ",
  "credit.intentDelete": "راکړه ورکړه ړنګه کړئ",
  "credit.pendingHold": "په تمه دي چې سرور حد وګوري. تر تایید پورې هېڅ شی مه سپارئ.",
  "credit.signInToSend": "نه دي لېږل شوي: ننوځئ چې سرور یې وګوري",
  "credit.refusalOne": "حد د {name} یوه راکړه ورکړه ودروله: {what}، {when}",
  "credit.refusalMany":
    "حد په تېرو 30 ورځو کې {count} راکړې ورکړې ودرولې. وروستۍ د {name} له خوا: {what}، {when}",
  "credit.refusalSomeone": "یو کارکوونکی",
  "credit.refused": "د پور له حده واوښت — ثبت نه شو",
  "credit.intentsTitle": "په تمه / نه دي ثبت شوي",
  "credit.onlineSave":
    "چې ننوځئ، د حد هر ځل خوندي کول انټرنېټ ته اړتیا لري، څو ټول ټیلیفونونه یو شان قاعده ولري.",
  "credit.saveFailed": "حدونه خوندي نه شول. خپل انټرنېټ وګورئ او بیا هڅه وکړئ.",
  "credit.limitInvalid": "صفر یا مثبت مبلغ ولیکئ چې تر دوو اعشاري ځایونو پورې ولري",
  "credit.recorded": "ثبت شو",
  "credit.statusOver": "د پور له حده اوښتی",
  "credit.statusNear": "د پور حد ته نږدې",
  "credit.save": "حدونه خوندي کړئ",
  "credit.saved": "د پور حدونه خوندي شول",
  "reminders.title": "یادونې",
  "reminders.personal": "یوازې ستاسې لپاره په دې ټیلیفون کې دي. پېرودونکي ته څه نه لېږل کېږي.",
  "reminders.add": "یادونه زیاته کړئ",
  "reminders.edit": "یادونه سمه کړئ",
  "reminders.once": "یو ځل",
  "reminders.daily": "هره ورځ",
  "reminders.weekly": "هره اونۍ",
  "reminders.monthly": "هره میاشت",
  "reminders.chooseWeekdays": "هرې ورځې چې غواړئ، غوره یې کړئ.",
  "reminders.chooseOneDay": "لږ تر لږه یوه ورځ غوره کړئ.",
  "reminders.repeatEvery": "تکرار په هرو",
  "reminders.oneMonth": "1 میاشت",
  "reminders.monthCount": "{months} میاشتې",
  "reminders.monthlyDate": "د تکرار ورځ او میاشت (میلادي)",
  "reminders.monthlyCalendar":
    "میاشتنۍ یادونې د میلادي کلیز له مخې دي. له 1 تر 28 ورځ غوره کړئ، څو دا نېټه په هره میاشت کې وي.",
  "reminders.monthDayRange": "له 1 تر 28 یوه ورځ غوره کړئ.",
  "reminders.onMonthlyDay": "د هرې میلادي میاشتې په {day} ورځ، په {time}",
  "reminders.onMonthInterval": "په هرو {months} میلادي میاشتو کې، په {day} ورځ، په {time}",
  "reminders.scheduleLimit":
    "په دې ټیلیفون کې د دې مهالوېش د خبرتیاوو لپاره نور ځای نشته. د اونۍ لږې ورځې یا اوږده موده غوره کړئ، یا بله یادونه لرې کړئ.",
  "reminders.date": "نېټه",
  "reminders.time": "وخت",
  "reminders.weekday": "د اونۍ ورځ",
  "reminders.everyDay": "هره ورځ په {time}",
  "reminders.everyWeekday": "هره {weekday} په {time}",
  "reminders.next": "راتلونکې: {date}",
  "reminders.due": "وخت یې رسېدلی",
  "reminders.dueShortcut": "د هغو یادونو شمېر چې وخت یې رسېدلی: {count}",
  "reminders.all": "ټولې",
  "reminders.empty": "دلته لا یادونې نشته.",
  "reminders.noDue": "د هېڅ یادونې وخت نه دی رسېدلی.",
  "reminders.markDone": "د بشپړې شوې په نښه کړئ",
  "reminders.remove": "یادونه لرې کړئ",
  "reminders.removeConfirm": "دا یادونه لرې شي؟",
  "reminders.saved": "یادونه خوندي شوه.",
  "reminders.future": "راتلونکې نېټه او وخت غوره کړئ.",
  "reminders.unavailable": "دا پېرودونکی نور نشته.",
  "reminders.permissionDenied": "خوندي شوه. خبرتیاوې بندې دي؛ دا یادونه به په Kaata کې ښکاره شي.",
  "reminders.notificationsOff":
    "د Kaata خبرتیاوې بندې دي، نو یادونې یوازې په اپ کې ښکاري. په خپل وخت د خبرتیا لپاره یې په امستنو کې فعالې کړئ.",
  "reminders.permissionUnavailable": "خوندي شوه. دا نسخه په Kaata کې دننه د یادونو ملاتړ کوي.",
  "reminders.nativeFailed":
    "خوندي شوه. د ټیلیفون خبرتیاوې مهالویش نه شوې؛ یادونه په Kaata کې پاتې ده.",
  "reminders.limit": "دا ټیلیفون تر 40 پورې فعالې یادونې لرلی شي.",
  "reminders.loadFailed":
    "په دې ټیلیفون کې یادونې ونه لوستل شوې. بیا هڅه وکړئ؛ که ستونزه دوام وکړي، Kaata له سره پرانیزئ.",
  "reminders.notifyBody": "د پېرودونکي د یادونې وخت رسېدلی. د لیدلو لپاره یې Kaata پرانیزئ.",
  "reminders.notifyBodyNamed":
    "وخت دی چې {name} ته د حساب یادونه وکړئ. د لېږلو لپاره Kaata پرانیزئ.",
  "entry.settledLocked":
    "دا راکړه ورکړه د تصفیې تر کرښې لاندې ده او نه شي بدلېدای. د سمون لپاره نوې راکړه ورکړه ورزیاته کړئ.",
  // Tally calculator
  "calculator.open": "حسابګر پرانیزئ",
  "calculator.title": "حسابګر",
  "calculator.close": "حسابګر وتړئ",
  "calculator.nextNote": "یادښت ته لاړ شئ",
  "calculator.useAmount": "مبلغ وکاروئ",
  "calculator.expression": "محاسبه",
  "calculator.result": "پایله",
  "calculator.history": "تېرې محاسبې",
  "calculator.historyTitle": "د دې راکړې ورکړې محاسبې",
  "calculator.historyEmpty": "ستاسو محاسبې به دلته ښکاره شي.",
  "calculator.clearHistory": "تېرې محاسبې پاکې کړئ",
  "calculator.backToCalculator": "بېرته حسابګر ته",
  "calculator.recallCalculation": "محاسبه بیا وکاروئ: {expression}",
  "calculator.clear": "ټول پاک کړئ",
  "calculator.delete": "وروستی رقم پاک کړئ",
  "calculator.add": "جمع کړئ",
  "calculator.subtract": "تفریق کړئ",
  "calculator.multiply": "ضرب کړئ",
  "calculator.divide": "ووېشئ",
  "calculator.percent": "سلنه",
  "calculator.equals": "پایله محاسبه کړئ",
  "calculator.sign": "نښه بدله کړئ",
  "calculator.parentheses": "قوسونه",
  "calculator.doubleZero": "دوه صفرونه",
  "calculator.decimal": "اعشاري ټکی",
  "calculator.memory": "حافظه",
  "calculator.memoryClear": "حافظه پاکه کړئ",
  "calculator.memoryRecall": "د حافظې شمېره وکاروئ",
  "calculator.memoryAdd": "پایله د حافظې له شمېرې سره جمع کړئ",
  "calculator.memorySubtract": "پایله د حافظې له شمېرې څخه تفریق کړئ",
  "calculator.invalid": "محاسبه بیا وګورئ.",
  "calculator.divisionByZero": "پر صفر وېشل نه شي کېدای.",
  "calculator.tooComplex": "دا محاسبه ډېره اوږده ده. څو برخې ترې لرې کړئ.",
  "calculator.tooLarge": "دا مبلغ د یوې راکړې ورکړې لپاره ډېر لوی دی.",
  "calculator.positiveAmount": "له صفر څخه لوی مبلغ وکاروئ.",
  "calculator.incomplete": "د مبلغ د کارولو لپاره محاسبه بشپړه کړئ.",
  "calculator.rounded": "تر ۲ اعشاري ځایونو پورې نږدې شوی",
  "calculator.memoryEmpty": "حافظه تشه ده",
  "calculator.helper": "دلته محاسبه وکړئ، بیا مبلغ په خپله راکړه ورکړه کې وکاروئ.",
  "entry.amount.label": "مبلغ (AFN)",
  "entry.note.label": "یادښت",
  "entry.date.label": "نېټه",
  "entry.more.show": "نور وښایئ",
  "entry.more.hide": "لږ وښایئ",
  "entry.currency.label": "اسعار",
  "entry.currency.fixed":
    "د دې راکړې ورکړې اسعار ثابت دي. د بل اسعارو لپاره نوې راکړه ورکړه زیاته کړئ.",
  "entry.currency.disabled": "دا اسعار نور د دې کاټې لپاره فعال نه دي. فعال اسعار وټاکئ.",
  "currency.view": "د اسعارو لید",
  "entry.note.placeholder": "اوړه او چای",
  "entry.save": "خوندي کړئ",
  "entry.saveChanges": "بدلونونه خوندي کړئ",
  "entry.context.to": "ته",
  "entry.context.from": "له",
  "entry.edit.title": "سمون · {verb}",
  "entry.edit.hint":
    "لوری نه شي بدلېدای. د «{otherVerb}» د ثبتولو لپاره دا راکړه ورکړه ړنګه کړئ او نوې ورزیاته کړئ.",
  "entry.notFound": "دا راکړه ورکړه نور نشته.",
  "entry.showExactTime": "کره نېټه او وخت وښایئ",
  "entry.showRelativeTime": "تېر شوی وخت وښایئ",
  "entry.options": "د راکړې ورکړې غوراوي",
  "entry.addedBy": "د {name} له خوا ورزیاته شوې",
  "entry.editedBy": "{name} سمون ورکړی",
  "entry.editedByOnly": "{name} سمون ورکړی",
  "entry.by.you": "تاسو",
  "entry.by.self": "{name} (تاسو)",
  "entry.by.someone": "بل غړی",
  "entry.invalidAmount": "له صفر څخه لوی مبلغ ولیکئ، تر دوو اعشاري ځایونو پورې",
  "entry.noActiveVault": "فعاله کاټه نشته. د دوام لپاره یوه جوړه کړئ.",
  "entry.vaultArchived": "دا کاټه آرشیف شوې ده. بېرته یې را وګرځوئ یا بله وټاکئ.",
  "entry.saved": "راکړه ورکړه خوندي شوه",
  "entry.updated": "راکړه ورکړه تازه شوه",
  "entry.deleted": "راکړه ورکړه ړنګه شوه",
  "entry.deleteFailed": "ړنګول ونه شول. بیا هڅه وکړئ.",
  "entry.saveFailed": "خوندي کول ونه شول. بیا هڅه وکړئ.",
  "entry.roleDenied": "یوازې یې کتلی شئ؛ له مالک څخه د سمون اجازه وغواړئ.",
  "entry.signingUnavailable":
    "د خوندي ثبت چمتو کول ونه شول. بیا هڅه وکړئ؛ که ستونزه دوام وکړي، کاټه بیا پرانیزئ.",
  "projectionConflicts.toast.roleGate": "ستاسو واک بدل شوی دی؛ دا بدلون خوندي نه شو.",
  "projectionConflicts.toast.serverRejected":
    "سرور ستاسو وروستی بدلون ونه مانه. مهرباني وکړئ معلومات تازه کړئ.",
  "entry.amount.labelTemplate": "مبلغ ({code})",
  "auditLog.title": "فعالیت",
  "auditLog.noViewerAccess": "کتونکي د فعالیتونو مخینې ته لاسرسی نه لري.",
  "auditLog.toast.noActive": "فعاله کاټه نشته",
  "auditLog.toast.loadFailed": "د فعالیتونو مخینه پورته نه شوه",
  "auditLog.notAvailable.title": "فعالیت نشته",
  "auditLog.notAvailable.body": "دا کاټه په سرور کې د فعالیتونو مخینه نه لري.",
  "auditLog.empty.title": "تر اوسه فعالیت نشته",
  "auditLog.empty.body": "د دې کاټې فعالیتونه — راکړې ورکړې، کسان او امستنې — به دلته ښکاري.",
  "auditLog.endOfHistory": "د مخینې پای",
  "auditLog.system": "سیستم",
  "auditLog.kind.inviteIssued": "بلنه ولېږل شوه",
  "auditLog.kind.inviteAccepted": "بلنه ومنل شوه",
  "auditLog.kind.roleChanged": "ونډه بدله شوه",
  "auditLog.kind.memberRevoked": "غړی لرې شو",
  "auditLog.kind.memberLeft": "غړی ووت",
  "auditLog.kind.vaultArchived": "کاټه ارشیف شوه",
  "auditLog.kind.vaultUnarchived": "کاټه له ارشیفه راوایستل شوه",
  "auditLog.kind.transferInitiated": "د مالکیت سپارل پیل شول",
  "auditLog.kind.transferCompleted": "مالکیت وسپارل شو",
  "auditLog.kind.local.addedMember": "غړی زیات شو",
  "auditLog.kind.local.addedMemberAs": "غړی د {role} په توګه زیات شو",
  "auditLog.kind.local.roleChangedTo": "ونډه {role} ته بدله شوه",
  "auditLog.kind.local.currencyChanged": "د پیسو ډول بدل شو",
  "auditLog.kind.local.currencyChangedTo": "د پیسو ډول {value} ته بدل شو",
  "auditLog.kind.local.renamed": "د کاټې نوم بدل شو",
  "auditLog.kind.local.renamedTo": "نوم {value} ته بدل شو",
  "auditLog.kind.local.settingChanged": "امستنه بدله شوه",
  "auditLog.kind.local.settingChangedKey": "امستنه بدله شوه: {key}",
  "auditLog.kind.local.shopProfileUpdated": "د دوکان پېژندپاڼه تازه شوه",
  "auditLog.kind.local.entryAdded": "راکړه ورکړه زیاته شوه",
  "auditLog.kind.local.entryEdited": "راکړه ورکړه سمه شوه",
  "auditLog.kind.local.entryDeleted": "راکړه ورکړه ړنګه شوه",
  "auditLog.kind.local.personAdded": "کس زیات شو",
  "auditLog.kind.local.personRenamed": "د کس نوم بدل شو",
  "auditLog.kind.local.personArchived": "کس ارشیف شو",
  "auditLog.kind.local.personUnarchived": "کس له ارشیفه راوایستل شو",
  "auditLog.target": "موخه: {id}",
  "auditLog.relative.justNow": "همدا اوس",
  "auditLog.relative.minutesAgo": "{n} دقیقې مخکې",
  "auditLog.relative.hoursAgo": "{n} ساعته مخکې",
  "auditLog.relative.daysAgo": "{n} ورځې مخکې",
  "auditLog.relative.monthsAgo": "{n} میاشتې مخکې",
  "menu.title.profile": "پروفایل او تنظیمات",
  "menu.title.vaultSwitcher": "کاټه بدله کړئ",
  "menu.thisKaata.settings": "دا کاټه اداره کړئ",
  "menu.currentKaata": "اوسنۍ کاټه",
  "menu.account.settings": "د حساب تنظیمات",
  "menu.account.settings.hint": "نوم، شمېره، ژبه",
  "menu.help": "مرسته",
  "menu.guide": "کاټه څنګه کار کوي",
  "menu.guide.hint": "کاټې، راکړې ورکړې او د دوی اړیکه",
  "menu.allKaatas": "ټولې کاټې",
  "menu.allKaatas.empty": "تراوسه کاټې نشته.",
  "menu.allKaatas.empty.withArchived": "فعاله کاټې نشته.",
  "menu.allKaatas.add": "کاټه ورزیاته کړئ",
  "menu.allKaatas.scan": "د نښلولو کوډ سکین کړئ",
  "menu.allKaatas.scan.hint": "له بل ټیلیفون څخه له شته کاټې سره یوځای شئ",
  "menu.allKaatas.switched": "کاټه بدله شوه",
  "menu.allKaatas.switchFailed": "کاټه بدله نه شوه",
  "menu.allKaatas.archived.show": "آرشیف شوې وښایئ ({count})",
  "menu.allKaatas.archived.hide": "آرشیف شوې پټې کړئ ({count})",
  "menu.allKaatas.archived.view": "آرشیف شوې ({count})",
  "vaultArchived.title": "آرشیف شوې",
  "vaultArchived.empty": "تراوسه آرشیف شوې کاټې نشته.",
  "vaultArchived.emptySubtitle": "ټولې کاټې مو بېرته فعالې شوې دي.",
  "vaultArchived.emptyCta": "کاټو ته ستانه شئ",
  "vaultArchived.restoreButton": "بېرته یې را وګرځوئ",
  "vaultArchived.restoreFromCloud": "له کلاوډ څخه بېرته را وګرځوئ",
  "vaultArchived.serverAnchoredHint":
    "په سرور کې ساتل شوې ده؛ د کلاوډ بیک‌اپ له لارې یې بېرته را وګرځوئ",
  "vaultArchived.restoredToast": "{name} بېرته راوګرځول شوه",
  "vaultArchived.restoreFailed": "کاټه بېرته راوګرځول نه شوه",
  "vaultArchived.unarchiveUnsupported":
    "د دې کاټې د بېرته راګرځولو لپاره یې له کلاوډ څخه را وګرځوئ",
  "vaultArchived.archivedAt": "{relative} آرشیف شوې",
  "vaultArchived.relative.justNow": "همدا اوس",
  "vaultArchived.relative.minutesAgo": "{n} دقیقې مخکې",
  "vaultArchived.relative.hoursAgo": "{n} ساعته مخکې",
  "vaultArchived.relative.daysAgo": "{n} ورځې مخکې",
  "vaultArchived.relative.monthsAgo": "{n} میاشتې مخکې",
  "vaultPicker.manage": "اوسنۍ کاټه اداره کړئ",
  "menu.sync": "همغږي",
  "menu.sync.never": "تراوسه همغږې شوې نه ده",
  "menu.sync.justNow": "همدا اوس",
  "menu.sync.minAgo": "{n} دقیقې مخکې",
  "menu.sync.hrAgo": "{n} ساعته مخکې",
  "menu.sync.dayAgo": "{n} ورځې مخکې",
  "menu.sync.status.busy": "بیک‌اپ جوړېږي…",
  "menu.sync.status.never": "تراوسه بیک‌اپ نه دی جوړ شوی؛ له انټرنېټ سره په نښلېدو به جوړ شي.",
  "menu.sync.status.ok": "بیک‌اپ جوړ شوی • {when}",
  "menu.sync.cloud": "د کلاوډ بیک‌اپ",
  "menu.sync.cloud.hint":
    "د دې کاټې بیک‌اپ جوړوي او د انټرنېټ له لارې یې ستاسو له نورو ټیلیفونونو سره همغږې کوي.",
  "menu.sync.cloud.hintOff": "بند دی؛ دا کاټه یوازې له نږدې ټیلیفونونو سره همغږې کېږي.",
  "menu.sync.cloud.onToast": "د کلاوډ بیک‌اپ فعال شو.",
  "menu.sync.cloud.offToast": "د کلاوډ بیک‌اپ بند شو.",
  "menu.sync.cloud.failed": "د کلاوډ بیک‌اپ بدل نه شو.",
  "menu.sync.done": "همغږي شوه ({pulled} ترلاسه، {pushed} ولېږل شول)",
  "menu.sync.failed": "همغږي ناکامه شوه",
  "menu.sync.offline": "داسې ښکاري چې له انټرنېټ سره نه یاست نښتي.",
  "menu.sync.header.never": "—",
  "menu.sync.shopMode": "له نږدې ټیلیفونونو سره همغږي",
  "menu.sync.shopMode.hint":
    "د بلوتوث یا وای‌فای له لارې همغږي روانه ساتي، ان که کاټه بنده وي. انټرنېټ ته اړتیا نشته.",
  "menu.sync.shopMode.hintWithPeers": "{count} نږدې ټیلیفونونه",
  "menu.sync.shopMode.hintOnePeer": "۱ نږدې ټیلیفون",
  "menu.sync.shopMode.hintLooking": "نږدې ټیلیفونونه لټول کېږي…",
  "menu.sync.shopMode.failed": "له نږدې ټیلیفونونو سره همغږي بدله نه شوه.",
  "menu.sync.shopMode.fgsFailed":
    "له نږدې ټیلیفونونو سره همغږي پیل نه شوه؛ مهرباني وکړئ د خبرتیاوو اجازه ورکړئ او بیا هڅه وکړئ.",
  "menu.sync.shopMode.startedToast": "له نږدې ټیلیفونونو سره همغږي فعاله شوه.",
  "menu.sync.bgSync": "په شالید کې همغږي",
  "menu.sync.bgSync.hint": "همغږي روانه ساتي، ان که کاټه بنده وي. لږه زیاته بیټرۍ کاروي.",
  "menu.sync.bgSync.hintOff": "یوازې هغه مهال همغږي کېږي چې کاټه پرانیستې وي.",
  "menu.sync.bgSync.onToast": "په شالید کې همغږي فعاله شوه.",
  "menu.sync.bgSync.offToast": "په شالید کې همغږي بنده شوه.",
  "menu.sync.bgSync.failed": "په شالید کې همغږي بدله نه شوه.",
  "menu.ble.permRationale.title": "د نږدې ټیلیفونونو د موندلو لپاره د بلوتوث اجازه ورکړئ",
  "menu.ble.permRationale.body":
    "کاټه په دوکان کې ستاسو د بل ټیلیفون او د کارکوونکو د ټیلیفونونو د موندلو لپاره بلوتوث کاروي. انټرنېټ ته اړتیا نشته. موږ هېڅکله ستاسو موقعیت نه شریکوو.",
  "menu.ble.permRationale.continue": "دوام ورکړئ",
  "menu.ble.permRationale.cancel": "اوس نه",
  "menu.ble.permDenied.title": "د بلوتوث اجازه اړینه ده",
  "menu.ble.permDenied.body":
    "له نږدې ټیلیفونونو سره همغږي ستاسو د نورو ټیلیفونونو د موندلو لپاره د بلوتوث اجازې ته اړتیا لري. د اجازې ورکولو لپاره تنظیمات پرانیزو؟",
  "menu.ble.permDenied.openSettings": "تنظیمات پرانیزئ",
  "menu.ble.permDenied.cancel": "اوس نه",
  "menu.ble.unsupported":
    "دا ټیلیفون د بلوتوث خپرونه نه شي کولای؛ له نږدې ټیلیفونونو سره همغږي دلته کار نه کوي.",
  "menu.ble.adapterOff": "بلوتوث بند دی. له نږدې ټیلیفونونو سره د همغږۍ لپاره یې فعال کړئ.",
  "menu.ble.peripheralUnsupported":
    "ستاسو ټیلیفون نورو ته د بلوتوث خپرونه نه شي کولای، خو د کاټې نږدې ټیلیفونونه موندلی شي. له بل ټیلیفون څخه وغواړئ چې نږدې همغږي فعاله کړي.",
  "menu.ble.peerHandshakeFailed":
    "له نږدې ټیلیفون سره نښلېدل ونه شول. کېدای شي د بلې کاټې وي یا یې د ننوتلو موده پای ته رسېدلې وي.",
  "menu.ble.peerDecryptFailed": "له نږدې ټیلیفون سره اړیکه پرې شوه. بیا هڅه کېږي.",
  "menu.ble.peerOutdated": "یوه نږدې کاټه له همغږۍ مخکې تازه کولو ته اړتیا لري.",
  "menu.battery.title": "وروستی ګام: په شالید کې د کار اجازه ورکړئ",
  "menu.battery.description":
    "له نږدې ټیلیفونونو سره د همغږۍ لپاره Android باید د کاټې د بلوتوث لټون روان وساتي، ان که ټیلیفون مو قلف وي یا په جېب کې وي. بل ګام: تنظیمات ← بیټرۍ ← بې محدودیت.",
  "menu.battery.confirm": "تنظیمات پرانیزئ",
  "menu.battery.skip": "تېر شئ؛ له نږدې ټیلیفونونو سره همغږي بنده کړئ",
  "menu.oemAutostart.title": "کاټې ته د خپل‌سري پیل اجازه ورکړئ",
  "menu.oemAutostart.description":
    "ستاسو د ټیلیفون جوړوونکی ښايي د بیټرۍ له اجازې سره هم کاټه په شالید کې بنده کړي. په بل مخ کې کاټه ومومئ او خپل‌سری پیل (یا «محدود یې مه کړئ / په شالید کې اجازه ورکړئ») فعال کړئ.",
  "menu.oemAutostart.confirm": "د خپل‌سري پیل تنظیمات پرانیزئ",
  "menu.account": "حساب",
  "menu.account.signIn": "د ګوګل له لارې ننوځئ",
  "menu.account.signIn.choose": "ننوځئ",
  "menu.account.signIn.apple": "د اپل له لارې ننوځئ",
  "menu.account.signIn.email": "د برېښنالیک له لارې ننوځئ",
  "menu.account.signIn.toast": "حساب ته ننوتئ",
  "menu.account.signIn.partialToast":
    "حساب ته ننوتئ، خو {count} کاټې بېرته راوګرځول نه شوې. د بیا هڅې لپاره بیا ننوځئ.",
  "menu.account.signIn.failed": "ننوتل ونه شول؛ بیا هڅه وکړئ",
  "menu.account.signIn.signingIn": "حساب ته ننوتل کېږي…",
  "menu.account.signIn.restoring": "ستاسو کاټې بېرته راګرځول کېږي…",
  "menu.account.signOut": "له حسابه ووځئ",
  "menu.account.signOut.pending": "له حسابه وتل کېږي…",
  "menu.account.signOut.toast": "له حسابه ووتئ",
  "menu.account.signOut.failed": "له حسابه وتل ونه شول؛ بیا هڅه وکړئ",
  "menu.account.signOut.confirm.title": "له حسابه وځئ؟",
  "menu.account.signOut.confirm.body":
    "له {email} څخه به ووځئ. ستاسو د ټیلیفون کاټې دلته پاتې کېږي، خو تر بیا ننوتلو پورې د کلاوډ همغږي او بېرته راګرځول کار نه کوي.",
  "menu.account.signOut.confirm.bodyGeneric":
    "ستاسو د ټیلیفون کاټې دلته پاتې کېږي، خو تر بیا ننوتلو پورې د کلاوډ همغږي او بېرته راګرځول کار نه کوي.",
  "menu.account.signOut.confirm.cta": "له حسابه ووځئ",
  "menu.account.switch": "حساب بدل کړئ",
  "menu.account.localOnlyHint": "د بیک‌اپ او د ټیلیفونونو ترمنځ د همغږۍ د فعالولو لپاره ننوځئ.",
  "menu.about": "په اړه",
  "members.singular": "{count} غړی",
  "members.plural": "{count} غړي",
  "ownershipTransfer.title": "مالکیت وسپارئ",
  "ownershipTransfer.intro":
    "یو څوک راوبلئ چې د دې کاټې مالکیت واخلي. تر هغه چې بلنه ومني، تاسو خاوند پاتې کېږئ؛ بیا به د سمونګر په توګه لاسرسی لرئ. تر سپارلو مخکې ټول هغه ټیلیفونونه تازه کړئ چې دا کاټه کاروي.",
  "ownershipTransfer.ownerOnly": "یوازې خاوند د دې کاټې مالکیت سپارلای شي.",
  "ownershipTransfer.signedOut": "د مالکیت د بلنې جوړولو لپاره ننوځئ.",
  "ownershipTransfer.offline": "د مالکیت د دې بلنې د سمبالولو لپاره له انټرنېټ سره وصل شئ.",
  "ownershipTransfer.unavailable":
    "تر سپارلو مخکې باید دا کاټه فعاله وي، بشپړه همغږې شوې وي او مالکیت یې ستاسو په ننوتلي حساب پورې تړلی وي.",
  "ownershipTransfer.loadFailed": "د مالکیت بلنې ونه کتل شوې. د لینک تر جوړولو مخکې بیا هڅه وکړئ.",
  "ownershipTransfer.refresh": "حالت وګورئ",
  "ownershipTransfer.recipient": "نوی خاوند",
  "ownershipTransfer.emailHint":
    "د منلو لپاره باید په همدې برېښنالیک ننوځي. بل چا ته د لینک لېږل هغه ته مالکیت نه ورکوي.",
  "ownershipTransfer.create": "د مالکیت لینک جوړ کړئ",
  "ownershipTransfer.confirmTitle": "نوي خاوند ته بلنه ورکړئ؟",
  "ownershipTransfer.confirmBody":
    "{email} به وکولای شي د دې ټولې کاټې، د غړو او ګډو حسابونو په ګډون، مالکیت ومني. تر منلو پورې تاسو خاوند پاتې کېږئ. تر منلو وروسته به د سمونګر په توګه پاتې شئ او یوازې نوی خاوند به وکولای شي مالکیت بېرته تاسو ته وسپاري.",
  "ownershipTransfer.created": "د مالکیت بلنه جوړه شوه",
  "ownershipTransfer.pending": "د منلو په تمه",
  "ownershipTransfer.expires": "په {when} پای ته رسېږي",
  "ownershipTransfer.pendingHint":
    "تاسو لا هم خاوند یاست. بلل شوی کس یوازې له ننوتلو او د دې بلنې تر منلو وروسته خاوند کېږي.",
  "ownershipTransfer.linkNotStored":
    "د محرمیت لپاره، لینک یوازې په هغه پاڼه کې ښکاري چې پکې جوړ شوی. د نوي لینک د اخیستلو لپاره دا بلنه لغوه او بله جوړه کړئ.",
  "ownershipTransfer.shareEmail": "په برېښنالیک یې ولېږئ",
  "ownershipTransfer.shareMessage":
    "بلنه درکوم چې په کاټه کې د {name} خاوند شئ. په هغه برېښنالیک ننوځئ چې بلنه ورته شوې او د مالکیت سپارل دلته وګورئ: {url}",
  "ownershipTransfer.emailSubject": "د {name} د مالکیت بلنه",
  "ownershipTransfer.shareUnavailable": "د پیغامونو اپ پرانیستل نه شو. لینک کاپي کولای شئ.",
  "ownershipTransfer.cancel": "بلنه لغوه کړئ",
  "ownershipTransfer.cancelTitle": "د مالکیت بلنه لغوه کړئ؟",
  "ownershipTransfer.cancelBody":
    "لینک به نور کار ونه کړي. تاسو به خاوند پاتې شئ او بل چا ته به بلنه ورکولای شئ.",
  "ownershipTransfer.cancelled": "د مالکیت بلنه لغوه شوه",
  "ownershipTransfer.alreadyPending":
    "د مالکیت یوه بلنه له مخکې د منلو په تمه ده. تر بلې جوړولو مخکې یې حالت وګورئ یا یې لغوه کړئ.",
  "ownershipTransfer.selfTransfer": "بل کس وټاکئ. تاسو له مخکې د دې کاټې خاوند یاست.",
  "ownershipTransfer.failed": "د مالکیت بلنه تازه نه شوه. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "ownershipTransfer.existingMember": "یو اوسنی غړی وټاکئ",
  "ownershipTransfer.existingMemberHint": "مالکیت نېغ هغه چا ته وسپارئ چې له مخکې په دې کاټه کې دی",
  "members.title": "غړي",
  "members.section.members": "غړي ({count})",
  "members.section.pending": "د منلو په تمه بلنې ({count})",
  "members.empty": "تر اوسه غړي نشته.",
  "members.nameUnavailable": "نوم نشته",
  "members.youSuffix": " (تاسو)",
  "members.transferBanner": "د مالکیت د سپارلو لپاره د یوه غړي نوم ووهئ.",
  "members.row.addMember": "غړی زیات کړئ",
  "members.row.addMember.hint": "د مخامخ نښلولو لپاره QR وښایئ — بې انټرنېټه هم کار کوي",
  "members.row.sendInvite": "د بلنې لینک ولېږئ",
  "members.row.sendInvite.hint": "د ګډون لینک په برېښنالیک ولېږئ — انټرنېټ غواړي",
  "members.expiresIn.soon": "ژر",
  "members.expiresIn.hours": "په {hours} ساعتونو کې",
  "members.expiresIn.days": "په {days} ورځو کې",
  "members.expiresLabel": "په {when} پای ته رسېږي",
  "members.toast.noActive": "فعاله کاټه نشته",
  "members.toast.loadFailed": "غړي پورته نه شول",
  "members.toast.roleUpdated": "ونډه تازه شوه",
  "members.toast.cannotChangeSelf": "خپله ونډه نه شئ بدلولای.",
  "members.toast.roleFailed": "ونډه بدله نه شوه",
  "members.toast.removed": "غړی لرې شو",
  "members.toast.removeFailed": "غړی لرې نه شو",
  "members.toast.transferred": "مالکیت {name} ته وسپارل شو",
  "members.toast.transferFailed": "مالکیت ونه سپارل شو",
  "members.toast.transferSyncRequired":
    "د مالکیت تر سپارلو مخکې باید د دې ټیلیفون همغږي بشپړه شي. له انټرنېټ سره وصل شئ، پرېږدئ دا کاټه همغږې شي، بیا هڅه وکړئ.",
  "members.toast.transferNotMember": "{name} نور د دې کاټې غړی نه دی. لېست تازه شو.",
  "members.toast.transferPartialRecovered":
    "مالکیت بشپړ ونه سپارل شو. څه نه دي بدل شوي — بیا هڅه وکړئ.",
  "members.toast.transferPartialUnrecovered":
    "مالکیت نیمګړی سپارل شوی: اوس دوه خاوندان شته. د سمولو لپاره د یوه خاوند غورنۍ پرانیزئ.",
  "members.sheet.title": "{name} سمبال کړئ",
  "members.sheet.makeEditor": "سمونګر یې کړئ",
  "members.sheet.makeViewer": "کتونکی یې کړئ",
  "members.sheet.makeManager": "سمبالوونکی یې کړئ",
  "members.rolesHelp":
    "سمبالوونکي کارکوونکي او د پور حدونه سمبالوي. یوازې خاوندان سمبالوونکي ټاکلای، مالکیت سپارلای او دا کاټه ارشیف کولای شي.",
  "members.credit.action": "د پور د حد واکونه",
  "members.credit.title": "د پور واکونه · {name}",
  "members.credit.inherit": "د ونډې له مخې",
  "members.credit.inheritHint": "د دې غړي د ونډې لپاره د پېرودونکي ټاکلی محدودیت وکاروئ.",
  "members.credit.enforce": "کلک حدونه باید مراعات کړي",
  "members.credit.enforceHint":
    "ټول کلک حدونه پرې پلي کړئ، ان که د دې غړي ونډه ترې مستثنا وي. یوازې د خبرتیا حدونه به هماغسې خبرتیاوې پاتې شي.",
  "members.credit.bypass": "له حدونو اوښتلای شي",
  "members.credit.bypassHint":
    "دې غړي ته له کلکو حدونو د اوښتلو اجازه ورکړئ. د پور خبرتیاوې به لا هم ښکاري.",
  "members.credit.onlineRequired": "د غړي د واکونو د بدلولو لپاره ننوځئ او له انټرنېټ سره وصل شئ.",
  "members.credit.loadFailed": "اوسني واکونه پورته نه شول. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "members.credit.saveFailed": "واک خوندي نه شو. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "members.credit.memberNeedsSignIn":
    "له دې غړي وغواړئ چې ننوځي او همغږي وکړي، بیا یې د پور واک بدل کړئ.",
  "members.credit.saved": "د پور واک خوندي شو",
  "members.credit.working": "د پور واکونه کتل کېږي…",
  "members.appleHiddenEmail": "د اپل حساب · برېښنالیک پټ دی",
  "members.sheet.makeClerk": "کارکوونکی یې کړئ",
  "members.sheet.transfer": "مالکیت وسپارئ",
  "members.sheet.remove": "له کاټې یې لرې کړئ",
  "members.confirm.remove.title": "دا غړی لرې کړئ؟",
  "members.confirm.remove.body":
    "دې کاټې ته به یې لاسرسی سمدستي پای ته ورسېږي. پخواني کارونه یې په کاټه او د فعالیتونو په مخینه کې پاتې کېږي.",
  "members.confirm.remove.cta": "لرې کړئ",
  "members.confirm.transfer.title": "{name} خاوند کړئ؟",
  "members.confirm.transfer.body":
    "ستاسو ونډه به سمونګر ته بدله شي. یوازې {name} به وکولای شي غړي زیات یا لرې کړي، امستنې بدلې کړي یا مالکیت بېرته تاسو ته وسپاري. دا بدلون به د هغوی د ټیلیفون په راتلونکې همغږۍ کې ښکاره شي.",
  "members.confirm.transfer.fallback": "دا غړی",
  "members.confirm.transfer.cta": "{name} خاوند کړئ",
  "members.confirm.transfer.cta.fallback": "خاوند یې کړئ",
  "ownershipAccept.title": "د مالکیت بلنه",
  "ownershipAccept.heading": "د {name} خاوند شئ",
  "ownershipAccept.body":
    "{inviter} تاسو ته د دې کاټې مالکیت درسپاري. غړي، امستنې او ارشیف کول به یې تاسو سمبالوئ. هغه به د سمونګر په توګه پاتې شي. په هغه برېښنالیک ننوځئ چې بلنه یې ورته کړې.",
  "ownershipAccept.accept": "مالکیت ومنئ",
  "ownershipAccept.done": "د {name} د مالکیت بلنه ومنل شوه",
  "ownershipAccept.unavailable":
    "د مالکیت دا بلنه پای ته رسېدلې، لغوه شوې یا ستاسو حساب ته نشته. په هغه برېښنالیک ننوځئ چې خاوند بلنه ورته کړې، یا د نوي لینک غوښتنه ترې وکړئ.",
  "inbox.title": "خبرتیاوې",
  "inbox.bell": "خبرتیاوې، {count} نالوستې",
  "inbox.unread": "نالوستې",
  "inbox.markAll": "ټولې د لوستل شویو په نښه کړئ",
  "inbox.seeAll": "ټولې خبرتیاوې وګورئ",
  "inbox.empty": "ټولې خبرتیاوې مو لوستې دي. د ګډو حسابونو بدلونونه به دلته ښکاره شي.",
  "inbox.unavailable": "د خبرتیاوو د راوړلو لپاره له انټرنېټ سره وصل شئ.",
  "inbox.signIn": "د ګډو حسابونو د خبرتیاوو د لیدلو لپاره ننوځئ.",
  "inbox.failed": "خبرتیاوې نوې نه شوې.",
  "inbox.retry": "د بیا هڅې لپاره ټک وکړئ.",
  "inbox.openFailed": "دا حساب پرانیستل نه شو. خپل انټرنېټ او د لاسرسي اجازه وګورئ.",
  "tab.notify.detail.new": "{name} یوه راکړه ورکړه ({amount}) زیاته کړه. ویې منئ یا یې رد کړئ.",
  "tab.notify.detail.accepted": "ستاسې راکړه ورکړه ({amount}) د {name} له خوا ومنل شوه.",
  "tab.notify.detail.rejected":
    "ستاسې راکړه ورکړه ({amount}) د {name} له خوا رد شوه. په پاتې حساب کې نه شمېرل کېږي.",
  "tab.notify.detail.voided": "{name} یوه راکړه ورکړه ({amount}) باطله کړه.",
  "tab.savedSignIn": "په دې ټیلیفون کې خوندي شول. {name} ته د لېږلو لپاره ننوځئ.",
  "tab.link.title": "د هغوی له کاټې سره یې ونښلوئ",
  "tab.link.action": "ګډ حساب جوړ کړئ",
  "tab.link.confirm.title": "دا حساب شریک کړئ؟",
  "tab.link.confirm.body":
    "{name} به د دې حساب هره راکړه ورکړه ویني او راکړې ورکړې زیاتولای، منلای یا ردولای شي. رد شوې راکړې ورکړې ښکاري، خو په پاتې حساب کې نه شمېرل کېږي. اوسنی پاتې حساب د یوې ښکاره پیلنۍ راکړې ورکړې په توګه لېږدول کېږي.",
  "tab.link.confirm.ok": "ونښلوئ",
  "tab.link.whatsapp": "ونښلوئ او واټساپ پرانیزئ",
  "tab.link.ready": "بلنه چمتو ده",
  "tab.link.readyBody": "دا بلنه {name} ته ولېږئ، څو د خپل کاټه اپ له لارې ګډون وکړي.",
  "tab.link.inviteUnavailable":
    "دا حساب له مخکې نښلول شوی. یوازې هغه لوری یې بلنه شریکولای شي چې جوړ کړی یې دی.",
  "tab.link.failed": "ونښلول نه شو. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "tab.link.sent": "لینک ولېږل شو",
  "tab.opening.note": "تر نښلولو مخکې پاتې حساب",
  "tab.share.whatsapp": "لینک په واټساپ کې ولېږئ",
  "tab.share.copy": "لینک کاپي کړئ",
  "tab.copied": "لینک کاپي شو",
  "tab.share.again": "لینک بیا ولېږئ",
  "tab.regenerate": "نوی لینک (پخوانی نور کار نه کوي)",
  "tab.regenerate.title": "نوی لینک جوړ کړئ؟",
  "tab.regenerate.body":
    "هغه لینک چې مخکې مو لېږلی، د ټولو کسانو لپاره به کار پرېږدي. نوی لینک {name} ته ولېږئ.",
  "tab.regenerate.ok": "نوی لینک",
  "tab.unlink": "اړیکه پرې کړئ",
  "tab.unlink.title": "له {name} سره اړیکه پرې کړئ؟",
  "tab.unlink.body":
    "له همغږي کېدو وروسته، هېڅ لوری نوې ګډې راکړې ورکړې یا د دې حساب له لارې خبرتیاوې نه شي لېږلای. منل شوې راکړې ورکړې او تایید شوی پاتې حساب ساتل کېږي. په تمه راکړې ورکړې د هماغو اصولو له مخې لا هم کتل یا لغوه کېدای شي. ستاسو په خپله کاټه کې نوې راکړې ورکړې شخصي دي.",
  "tab.unlink.pending":
    "د اړیکې پرې کول همغږي کېدو ته په تمه دي. د دواړو ټیلیفونونو د ګډ کار د درولو لپاره انټرنېټ سره وصل شئ.",
  "tab.history.pending":
    "تر بیا نښلولو مخکې، د پخوانۍ ګډې دورې په تمه راکړې ورکړې وګورئ او همغږې یې کړئ.",
  "tab.history.changed":
    "ګډه تاریخچه بدله شوې ده. تازه یې کړئ او تر بیا نښلولو مخکې لومړنی پاتې حساب وګورئ.",
  "tab.history.openingRequired":
    "دا کس لا هم تایید شوی ګډ پاتې حساب لري. د بیا نښلولو لپاره داسې لومړنی پاتې حساب پکار دی چې بل لوری یې بیاکتنه وکړای شي.",
  "tab.balance.confirmed": "تایید شوی ګډ پاتې حساب: {amount} {currency}",
  "tab.balance.pending": "{count} په تمه · خالص بدلون {amount} {currency}",
  "tab.unlinked": "اړیکه پرې شوه",
  "tab.chip.linked": "نښلول شوی · {name}",
  "tab.chip.waiting": "لینک ولېږل شو · په تمه",
  "tab.beforeLinking": "تر نښلولو مخکې · {count}",
  "tab.notSent": "نه دي لېږل شوې · {count}",
  "tab.notSent.body":
    "دا راکړې ورکړې ګډ حساب ته زیاتې نه شوې. د بیاکتنې لپاره په دې ټیلیفون کې ساتل شوې او په پاتې حساب کې نه شمېرل کېږي.",
  "tab.status.new": "نوې",
  "tab.status.accepted": "ومنل شوه",
  "tab.feedback.accepted": "راکړه ورکړه ({amount}) ومنل شوه.",
  "tab.feedback.rejected": "راکړه ورکړه ({amount}) رد شوه. په پاتې حساب کې نه شمېرل کېږي.",
  "tab.feedback.manyAccepted": "{count} راکړې ورکړې ومنل شوې.",
  "tab.feedback.manyRejected": "{count} راکړې ورکړې رد شوې. په پاتې حساب کې نه شمېرل کېږي.",
  "tab.feedback.mixed": "{accepted} ومنل شوې، {rejected} رد شوې. رد شوې راکړې ورکړې نه شمېرل کېږي.",
  "tab.status.pending": "په تمه",
  "tab.status.disputed": "رد شوه",
  "tab.status.voided": "لغوه شوه",
  "tab.status.sending": "لېږل کېږي…",
  "tab.addedBy": "د {name} له خوا زیاته شوې",
  "tab.addedByYou": "ستاسو له خوا زیاته شوې",
  "tab.disputedReason": "رد شوه: {reason}",
  "tab.void": "لغوه یې کړئ",
  "tab.cancel": "راکړه ورکړه لغوه کړئ",
  "tab.void.title": "دا راکړه ورکړه لغوه کړئ؟",
  "tab.void.body":
    "ښکاره پاتې کېږي، کرښه پرې راکاږل کېږي او نور نه شمېرل کېږي. که مبلغ ناسم و، نوې راکړه ورکړه زیاته کړئ.",
  "tab.voided": "راکړه ورکړه لغوه شوه",
  "tab.accept": "ومنئ",
  "tab.accepted": "ومنل شوه",
  "tab.rejectedHint": "په پاتې حساب کې نه شمېرل کېږي.",
  "tab.reviewFinal": "دا راکړه ورکړه له مخکې بیاکتل شوې. د بیا هڅې لپاره نوې راکړه ورکړه ولېږئ.",
  "tab.reject": "رد کړئ",
  "tab.dispute": "لامل ولیکئ…",
  "tab.dispute.title": "ردول · {amount}",
  "tab.dispute.reasonLabel": "څه ناسم دي؟",
  "tab.dispute.reasonPlaceholder": "لکه: ما 300 ورکړي، 500 نه",
  "tab.dispute.reasonRequired": "لامل ولیکئ، څو {name} پرې پوه شي.",
  "tab.dispute.reasonTooLong": "تر 300 تورو یې لنډ وساتئ.",
  "tab.dispute.send": "راکړه ورکړه رد کړئ",
  "tab.dispute.notFound": "دا راکړه ورکړه نور په ګډ حساب کې نشته.",
  "tab.disputed": "رد شوه — له پاتې حسابه وایستل شوه",
  "tab.closed": "دا ګډ حساب تړل شوی.",
  "tab.closedNote":
    "ګډ کار په {date} ودرول شو. تایید شوې راکړې ورکړې ساتل کېږي او په تمه راکړې ورکړې لا هم کتل کېدای شي. دلته نوې راکړې ورکړې شخصي دي.",
  "tab.settle.confirm":
    "له {name} سره بیاکتل شوی پاتې حساب صفر دی. دا راکړې ورکړې ستاسو دواړو ګډې مخینې ته ولېږدوئ او نوې پاڼه پیل کړئ؟ ریکارډونه خوندي پاتې کېږي او دا ګډ حساب همداسې کارولای شئ.",
  "tab.settle.pending":
    "د دې حساب تر تصفیې مخکې ټولې په تمه راکړې ورکړې بیا وګورئ او همغږې یې کړئ.",
  "tab.settle.changed": "ګډه مخینه بدله شوه. بیا یې وګورئ او د تصفیې هڅه بیا وکړئ.",
  "tab.settle.failed": "دا ګډ حساب تصفیه نه شو. له انټرنېټ سره وصل شئ او بیا هڅه وکړئ.",
  "tab.settle.history": "د {name} له خوا تصفیه شو · {date}",
  "tab.reviewedBy": "د {name} له خوا بیاکتل شوې",
  "tab.cancelledBy": "د {name} له خوا لغوه شوې",
  "tab.needsConnection": "ګډ حساب ته د راکړې ورکړې د زیاتولو لپاره له انټرنېټ سره وصل شئ.",
  "tab.editLocked":
    "ګډې راکړې ورکړې نه شي سمېدای. خپله په تمه راکړه ورکړه لغوه کولای شئ؛ د منل شوې راکړې ورکړې سمون نوي ثبت ته اړتیا لري.",
  "tab.currencyLocked": "د پیسو د ډول تر بدلولو مخکې د ګډو حسابونو اړیکې پرې کړئ.",
  "tab.duplicateHint": "د {name} له خوا له مخکې ثبت شوې — وګورئ چې دوه ځله ونه شمېرل شي.",
  "tab.them": "بل لوری",
  "tab.row.pending": "{count} د بیاکتنې لپاره",
  "tab.row.awaiting": "{count} تایید ته په تمه",
  "tab.row.notDownloaded": "ګډ حساب لا نه دی ډاونلوډ شوی",
  "tab.notDownloaded":
    "دا ګډ حساب لا دې ټیلیفون ته نه دی ډاونلوډ شوی. کله چې ډاونلوډ شي، پاتې حساب به یې ښکاره شي؛ که دا حالت دوام وکړي، خپله اړیکه وګورئ.",
  "tab.invite.message":
    "{name} تاسو سره د کاټې حساب شریکوي. د پاتې حساب د لیدلو او د راکړو ورکړو د زیاتولو یا منلو لپاره لینک پرانیزئ:\n{url}",
  "tab.join.title": "ګډ حساب",
  "tab.join.from": "{name} تاسو سره حساب شریکوي",
  "tab.join.balanceLabel": "پاتې حساب",
  "tab.join.entries": "{count} راکړې ورکړې",
  "tab.join.join": "ګډون وکړئ",
  "tab.join.pickKaata": "دا د کومې کاټې لپاره دی؟",
  "tab.join.pickContact": "{name} ستاسو په کاټه کې څوک دی؟",
  "tab.join.newContact": "نوې اړیکه",
  "tab.join.noCurrencyKaata": "د دې حساب لپاره په {currency} کاټې ته اړتیا لرئ.",
  "tab.join.createKaata": "په {currency} کاټه جوړه کړئ",
  "tab.join.done": "له {name} سره ونښلول شو",
  "tab.join.closed": "دا ګډ حساب تړل شوی.",
  "tab.join.notFound": "دا لینک نور اعتبار نه لري.",
  "tab.join.currencyMismatch": "ستاسو کاټه په {kaata} ده؛ دا حساب په {tab} دی.",
  "tab.join.sameKaata": "له خپلې کاټې سره حساب نه شئ شریکولای.",
  "tab.join.sameAccount":
    "تاسو له مخکې د دې ګډ حساب په بل لوري کې یاست (دا ستاسو کاټه ده، یا یې غړی یاست). په بل حساب ګډون وکړئ.",
  "tab.join.alreadyLinked": "دا کس له مخکې ګډ حساب لري.",
  "tab.join.currencyNotSynced":
    "ستاسو د کاټې د پیسو د ډول بدلون لا سرور ته نه دی رسېدلی. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "tab.join.currencyIntro": "ستاسو کاټه په {kaata} ده. دا ګډ حساب په {tab} دی.",
  "tab.join.switchCurrency": "{name} په {currency} وکاروئ",
  "tab.join.switchEmptyHint": "تر اوسه راکړه ورکړه نشته، نو څه نه بدلېږي.",
  "tab.join.switchRelabelHint":
    "اوسني مبلغونه به په {currency} وښودل شي، د اسعارو بدلون پرې نه محاسبه کېږي.",
  "tab.join.lockedByTab": "د ګډ حساب له امله په {currency} تړل شوی",
  "tab.join.lockedByRole": "یوازې خاوند یا سمبالوونکی د دې کاټې د پیسو ډول بدلولای شي",
  "tab.join.createSeparate": "په {currency} جلا کاټه جوړه کړئ",
  "tab.join.orPick": "یا د یوې کاټې د پیسو ډول {currency} ته بدل کړئ",
  "tab.join.switchConfirmTitle": "د {name} د پیسو ډول {currency} ته بدل کړئ؟",
  "tab.join.currencyPreset": "دا ګډ حساب {currency} کاروي. کاټه په همدې پیسو جوړېږي.",
  "tab.join.suggestTitle": "له هغې شمېرې سره سمون خوري چې دا بلنه ترې راغلې",
  "tab.join.suggestFromPhone": "ستاسو د ټیلیفون له اړیکو څخه",
  "tab.join.suggestFromInvite": "له بلنې څخه",
  "tab.join.suggestWillCreate": "ستاسو کاټې او د ټیلیفون اړیکو ته زیاتېږي",
  "tab.join.suggestWillAdd": "ستاسو کاټې ته زیاتېږي",
  "tab.join.linkTo": "له دې سره به ونښلول شي",
  "tab.join.chooseElse": "بل کس وټاکئ",
  "tab.join.joinAs": "له {name} سره یې ونښلوئ",
  "tab.join.searchContacts": "اړیکې ولټوئ",
  "tab.join.inKaata": "ستاسو په کاټه کې",
  "tab.join.switched": "{name} اوس {currency} کاروي",
  "tab.notify.channel": "ګډ حسابونه",
  "tab.notify.channelDescription":
    "هغه راکړې ورکړې چې بل لوري زیاتې یا بیاکتلې، کله چې کاټه په شالید کې وه.",
  "tab.notify.fallbackTitle": "ګډ حساب",
  "tab.notify.newEntries": "{count} نوې راکړې ورکړې د بیاکتنې لپاره",
  "tab.notify.reviewed": "ستاسو راکړې ورکړې بیاکتل شوې",
  "tab.notify.accepted": "ستاسو راکړه ورکړه ومنل شوه.",
  "tab.notify.rejected": "ستاسو راکړه ورکړه رد شوه او نور په پاتې حساب کې نه شمېرل کېږي.",
  "tab.notify.voided": "ستاسو په ګډ حساب کې یوه راکړه ورکړه لغوه شوه.",
  "tab.notify.actionFailed":
    "ستاسو ځواب ونه لېږل شو. د دې راکړې ورکړې د بیاکتنې لپاره کاټه پرانیزئ.",
  "invite.title": "غړي ته بلنه ورکړئ",
  "invite.link.intro":
    "د دې کاټې د شریکولو لپاره لینک جوړ کړئ. یوه کس ته یې ولېږئ — هغه به یې پرانیزي، ننوځي او ګډون به وکړي.",
  "invite.link.create": "لینک جوړ کړئ",
  "invite.link.createAnother": "بل لینک جوړ کړئ",
  "invite.link.viewerDisclosure":
    "کتونکي په دې کاټه کې هر څه لیدلای شي — ټول پاتې حسابونه او د ټیلیفون شمېرې — خو بدلون نه شي راوستلای.",
  "invite.link.editorDisclosure":
    "سمونګر په دې کاټه کې راکړې ورکړې زیاتولای، سمولای او ړنګولای شي. په ګډو حسابونو کې د بل لوري راکړې ورکړې هم منلای یا ردولای شي؛ دا پرېکړه وروستۍ ده. د حساب اړیکه هم پرېکولای شي.",
  "invite.managerNote":
    "خاوندان د کارکوونکو او د پور د حدونو د سمبالولو لپاره سمبالوونکي ټاکلای شي. لومړی کس راوبلئ، بیا «غړي» پرانیزئ، د هغه نوم ووهئ او «سمبالوونکی یې کړئ» وټاکئ.",
  "invite.link.clerkDisclosure":
    "کارکوونکي نوې راکړې ورکړې زیاتولای شي، خو پخوانۍ مخینه هېڅکله نه شي بدلولای یا ړنګولای.",
  "invite.link.ready": "لینک چمتو دی",
  "invite.link.readySub":
    "هر څوک چې دا لینک لري د {role} په توګه ګډون کولای شي. په {when} پای ته رسېږي.",
  "invite.shareWhatsapp": "په واټساپ کې یې شریک کړئ",
  "invite.tooMany": "د دې کاټې ډېر لینکونه لا فعال دي. لومړی ځینې وکاروئ یا باطل کړئ.",
  "invite.section.invitee": "بلل شوی کس",
  "invite.section.role": "ونډه",
  "invite.section.shareLink": "لینک شریک کړئ",
  "invite.email.label": "برېښنالیک",
  "invite.email.placeholder": "name@example.com",
  "invite.email.required": "برېښنالیک اړین دی",
  "invite.email.invalid": "سم برېښنالیک ولیکئ",
  "invite.email.alreadyInvited": "دې برېښنالیک ته له مخکې بلنه ورکړل شوې",
  "invite.email.alreadyMember": "دا برېښنالیک له مخکې غړی دی",
  "invite.gmailDotHint":
    "بلل شوی کس باید په هغه حساب بلنه ومني چې همدا برېښنالیک کاروي. د Gmail پتې له ټکو پرته سره پرتله کېږي.",
  "invite.role.editor": "سمونګر",
  "invite.role.editor.hint": "راکړې ورکړې زیاتې، سمې او ړنګې کړئ",
  "invite.role.viewer": "کتونکی",
  "invite.role.viewer.hint": "یوازې د لیدلو لاسرسی",
  "invite.role.clerk": "کارکوونکی",
  "invite.role.clerk.hint": "یوازې راکړې ورکړې زیاتول — سمول او ړنګول نشي کولای",
  "invite.submit": "بلنه جوړه کړئ",
  "invite.created": "بلنه جوړه شوه",
  "invite.failed": "بلنه جوړه نه شوه",
  "invite.ownerOnly": "یوازې د کاټې خاوند غړو ته بلنه ورکولای شي.",
  "invite.result.sent": "بلنه ولېږل شوه",
  "invite.result.sub": "{email} · په {when} پای ته رسېږي",
  "invite.copy": "لینک کاپي کړئ",
  "invite.copy.done": "لینک کاپي شو",
  "invite.copy.fallback": "لینک د شریکولو لپاره چمتو دی",
  "invite.copy.unavailable": "کاپي کول نشته",
  "invite.link.notOnServer": "د دې کاټې تر شریکولو مخکې باید همغږي یې بشپړه شي.",
  "invite.share": "له دې لارې یې شریک کړئ…",
  "invite.shareMessage": "زما په کاټه کې ګډون وکړئ: {url}",
  "invite.again": "بل چا ته بلنه ورکړئ",
  "invite.expiresIn.soon": "ژر",
  "invite.expiresIn.lessThanDay": "تر یوې ورځې په کمه موده کې",
  "invite.expiresIn.hours": "په {hours} ساعتونو کې",
  "invite.expiresIn.days": "په {days} ورځو کې",
  "invite.toast.noActive": "فعاله کاټه نشته",
  "invite.offline.banner": "انټرنېټ نه لرئ. د بلنې لینک جوړول انټرنېټ غواړي.",
  "invite.signInRequired": "د بلنې لینک جوړولو لپاره ننوځئ.",
  "inviteAccept.title": "د کاټې بلنه",
  "inviteAccept.invalidLink": "د بلنې لینک ناسم دی",
  "inviteAccept.signin.body":
    "د دې بلنې د منلو لپاره په هغه حساب ننوځئ چې د بلنې ترلاسه کوونکی برېښنالیک کاروي.",
  "inviteAccept.signin.cta": "ننوځئ",
  "inviteAccept.confirm.title": "په {name} کې ګډون وکړئ؟",
  "inviteAccept.confirm.body": "{inviter} تاسو ته د {role} په توګه د ګډون بلنه درکړې.",
  "inviteAccept.confirm.someone": "یو چا",
  "inviteAccept.confirm.accept": "ومنئ او ګډون وکړئ",
  "inviteAccept.confirm.decline": "رد یې کړئ",
  "inviteAccept.joining": "په کاټه کې ګډون کېږي…",
  "inviteAccept.joinedToast": "په {name} کې مو ګډون وکړ",
  "inviteAccept.pending.title": "ستاسو نښلول بشپړېږي",
  "inviteAccept.pending.body":
    "ستاسو بلنه ومنل شوه. د چمتو کولو د بشپړولو لپاره کاټه له انټرنېټ سره وصل وساتئ. بیا به په خپله هڅه وکړو.",
  "inviteAccept.blocked.title": "چمتو کول مرستې ته اړتیا لري",
  "inviteAccept.blocked.body": "چمتو کول بشپړ نه شول. د کاټې له خاوند څخه مرسته وغواړئ.",
  "inviteAccept.error.title": "ستونزه پېښه شوه",
  "inviteAccept.error.notVisible":
    "دا بلنه ستاسو په حساب کې نه ښکاري. بلنه په یوه ټاکلي برېښنالیک پورې تړلې ده — په هغه حساب د ننوتلو هڅه وکړئ چې بلنه یې ترلاسه کړې.",
  "inviteAccept.error.expired": "د دې بلنې موده پای ته رسېدلې. له بلنه ورکوونکي نوې بلنه وغواړئ.",
  "inviteAccept.error.loadFailed": "بلنه پورته نه شوه",
  "inviteAccept.error.rateLimited": "هڅې ډېرې شوې. وروسته بیا هڅه وکړئ.",
  "inviteAccept.error.acceptFailed": "بلنه ونه منل شوه",
  "wifiUpgrade.title": "د شاوخوا {count} راکړو ورکړو همغږي؛ پر بلوتوث نږدې {min} دقیقې",
  "wifiUpgrade.body":
    "دواړه ټیلیفونونه له یوه وای‌فای سره ونښلوئ، څو په څو ثانیو کې پای ته ورسېږي.",
  "wifiUpgrade.tryWifi": "وای‌فای وازمویئ",
  "wifiUpgrade.stayBle": "پر بلوتوث دوام ورکړئ",
  "wifiUpgrade.cancel": "همغږي ودروئ",
  "wifiUpgrade.toast.switched": "د چټکې همغږۍ لپاره وای‌فای ته واوښت",
  "wifiUpgrade.toast.fallback": "پر وای‌فای نښلېدل ونه شول؛ بلوتوث کارول کېږي",
  "wifiUpgrade.toast.autoDismissed": "پر بلوتوث دوام کوي",
  "wifiUpgrade.toast.searching": "بل ټیلیفون په وای‌فای کې لټول کېږي…",
  "vaultPair.title": "له دې کاټې سره ټیلیفون ونښلوئ",
  "vaultPair.twoWay.step1": "۱. پرېږدئ چې بل ټیلیفون دا کوډ سکین کړي.",
  "vaultPair.twoWay.step2": "۲. بیا د بشپړولو لپاره د هغه کوډ سکین کړئ.",
  "vaultPair.twoWay.scanTheirCode": "د بل ټیلیفون کوډ سکین کړئ",
  "vaultPair.twoWay.splitHint": "خپل کوډ وښایئ او د هغه کوډ سکین کړئ؛ دواړه په یو وخت کې.",
  "vaultPair.twoWay.yourCode": "ستاسو کوډ",
  "vaultPair.twoWay.theirCode": "د بل ټیلیفون کوډ",
  "vaultPair.twoWay.scanning.hint": "کمره د بل ټیلیفون کوډ ته ونیسئ",
  "vaultPair.twoWay.scanAgain": "بیا یې سکین کړئ",
  "vaultPair.twoWay.wrongCode":
    "دا د بل ټیلیفون د نښلولو کوډ نه دی. ترې وغواړئ چې خپل کوډ وښيي، بیا یې سکین کړئ.",
  "vaultPair.twoWay.bound.headline": "{name} اوس یوځای کېدای شي",
  "vaultPair.twoWay.bound.body":
    "د هغه ټیلیفون همغږي کېږي. کله چې بل ټیلیفون د یوځای کېدو پیغام وښيي، دا مخ تړلی شئ.",
  "vaultPair.twoWay.bound.headlineNoName": "بل ټیلیفون اوس یوځای کېدای شي",
  "vaultPair.twoWay.bound.startOver": "ناسم ټیلیفون دی؟ له سره پیل کړئ",
  "vaultPair.twoWay.bound.connecting": "دا مخ پرانیستی وساتئ؛ د {name} ټیلیفون نښلېږي…",
  "vaultPair.twoWay.bound.connectingNoName": "دا مخ پرانیستی وساتئ؛ بل ټیلیفون نښلېږي…",
  "vaultPair.twoWay.paired.headline": "له {name} سره ونښلول شو",
  "vaultPair.twoWay.paired.headlineNoName": "ونښلول شو",
  "vaultPair.twoWay.paired.body":
    "تاسو ونښلېدئ. کله چې ټیلیفونونه نږدې وي، بدلونونه د بلوتوث له لارې همغږي کېږي.",
  "vaultPair.twoWay.camera.headline": "د کمرې اجازه ورکړئ",
  "vaultPair.twoWay.camera.body": "کاټه د بل ټیلیفون د کوډ د سکین کولو لپاره کمرې ته اړتیا لري.",
  "vaultPair.twoWay.camera.allow": "د کمرې اجازه ورکړئ",
  "vaultPair.headline": "بل ټیلیفون ورسره ونښلوئ:",
  "vaultPair.instructions.local":
    "په بل ټیلیفون کې (هغه چې غواړئ ورزیات یې کړئ):\n۱. کاټه پرانیزئ.\n۲. د پروفایل نښه (ښي پاس) ← کاټه ورزیاته کړئ ← د نښلولو کوډ سکین کړئ.\n۳. کمره یې لاندې کوډ ته ونیسئ.",
  "vaultPair.instructions.server":
    "په بل ټیلیفون کې (هغه چې غواړئ ورزیات یې کړئ):\n۱. د کاټې په هماغه حساب ننوځئ.\n۲. د پروفایل نښه (ښي پاس) ← کاټه ورزیاته کړئ ← د نښلولو کوډ سکین کړئ.\n۳. کمره یې لاندې کوډ ته ونیسئ.",
  "vaultPair.codeExpired": "د کوډ موده پای ته ورسېده",
  "vaultPair.generating": "جوړېږي…",
  "vaultPair.issueFailed": "د نښلولو کوډ جوړ نه شو. خپله اړیکه وګورئ او بیا هڅه وکړئ.",
  "vaultPair.toast.paired": "یو ټیلیفون یوځای شو؛ د بلوتوث له لارې همغږی شو",
  "vaultPair.expiresIn": "په {time} کې یې موده پای ته رسېږي",
  "vaultPair.generateNew": "نوی کوډ جوړ کړئ",
  "vaultPair.sendLink": "پر ځای یې لینک ولېږئ",
  "vaultPair.sendLink.opening": "پرانیستل کېږي…",
  "vaultPair.shareLinkMessage": "زما بل ټیلیفون له کاټې سره ونښلوئ: {url}",
  "vaultPair.shareLinkReady": "لینک د شریکولو لپاره چمتو دی",
  "vaultPair.shareLinkFailed": "لینک شریک نه شو",
  "vaultPair.noActiveKaata": "فعاله کاټه نشته",
  "vaultPair.vaultNotFound": "کاټه ونه موندل شوه",
  "vaultPair.signInFirst": "د ټیلیفون د نښلولو لپاره لومړی ننوځئ",
  "vaultPair.loadFailed": "د نښلولو معلومات راوړل نه شول",
  "vaultPair.fineprint.local":
    "بل ټیلیفون حساب ته ننوتلو ته اړتیا نه لري؛ دواړه ټیلیفونونه نېغ په نېغه د بلوتوث له لارې نښلول کېږي.",
  "vaultPair.fineprint.server":
    "بل ټیلیفون باید د همدې ټیلیفون د کاټې حساب ته ننوتلی وي. بل کس (بل حساب) ته د بلنې لپاره «غړي ته بلنه ورکړئ» وکاروئ.",
  "vaultPair.role.title": "په دې کاټه کې د ټیلیفون واک وټاکئ:",
  "vaultPair.role.subtitle":
    "وټاکئ چې بل ټیلیفون تر نښلېدو وروسته د څه کولو اجازه ولري. وروسته یې بدلولی شئ.",
  "vaultPair.role.owner": "مالک",
  "vaultPair.role.owner.body":
    "بشپړ واک لري. غړي ورزیاتولی یا لرې کولی شي، واکونه بدلولی شي او هر څه سمولی او ړنګولی شي.",
  "vaultPair.role.editor": "سمونګر",
  "vaultPair.role.editor.body":
    "د ورځنیو کارونو کارکوونکی. راکړې ورکړې ورزیاتولی او سمولی شي، خو غړي نه شي اداره کولی.",
  "vaultPair.role.viewer": "کتونکی",
  "vaultPair.role.viewer.body":
    "یوازې د کتلو اجازه لري. پاتې حسابونه او راکړې ورکړې لیدلی شي، خو هېڅ بدلون نه شي راوستلی.",
  "vaultPair.role.continue": "د نښلولو کوډ وښایئ",
  "vaultPair.role.committed": "دا کوډ دا واک ورکوي: {role}",
  "vaultPairScan.title": "د نښلولو کوډ سکین کړئ",
  "vaultPairScan.showIdentity.headline": "دا دوکاندار ته وښایئ",
  "vaultPairScan.showIdentity.body":
    "هغه دا کوډ سکین کوي چې تاسو ورزیات کړي. کله چې یې سکین کړ، «دوام ورکړئ» ووهئ.",
  "vaultPairScan.showIdentity.continue": "دوام ورکړئ",
  "vaultPairScan.permission.headline": "کمرې ته د لاسرسي اجازه اړینه ده",
  "vaultPairScan.permission.body":
    "کاټه په بل ټیلیفون کې د ښودل شوي نښلولو کوډ د سکین کولو لپاره کمرې ته اړتیا لري. موږ هېڅ عکس نه ثبتوو او نه یې پورته کوو.",
  "vaultPairScan.permission.allow": "د کمرې اجازه ورکړئ",
  "vaultPairScan.scanning.hint": "کمره په بل ټیلیفون کې ښودل شوي QR کوډ ته ونیسئ",
  "vaultPairScan.confirm.prefix": "یوځای شئ:",
  "vaultPairScan.confirm.body.local":
    "دا ټیلیفون به د کاټې دویمه وسیله شي. دواړه ټیلیفونونه به یو بل ته د نږدې کېدو پر مهال د بلوتوث له لارې همغږي کېږي؛ انټرنېټ ته اړتیا نشته.",
  "vaultPairScan.confirm.body.server":
    "دا ټیلیفون به د کاټې دویمه وسیله شي. ستاسو راکړې ورکړې به د انټرنېټ له لارې، او کله چې دواړه ټیلیفونونه نږدې وي، نېغ په نېغه همغږي کېږي.",
  "vaultPairScan.confirm.join": "له کاټې سره یوځای شئ",
  "vaultPairScan.confirm.rescan": "بیا سکین کړئ",
  "vaultPairScan.joining": "له {name} سره یوځای کېږي…",
  "vaultPairScan.joined.headline": "ورسره ونښلول شو:",
  "vaultPairScan.joined.body.local":
    "دواړه ټیلیفونونه به یو بل ته د نږدې کېدو پر مهال د بلوتوث له لارې همغږي کېږي. له نږدې ټیلیفونونو سره همغږي فعاله ده.",
  "vaultPairScan.joined.body.syncing":
    "تاسو یوځای شوئ. لومړۍ همغږي بشپړه نه شوه؛ کله چې ټیلیفونونه نږدې وي، په خپله به په شالید کې بشپړه شي.",
  "vaultPairScan.joined.body.server":
    "دواړه ټیلیفونونه به د انټرنېټ له لارې، او د نږدې کېدو پر مهال د بلوتوث له لارې همغږي کېږي. له نږدې ټیلیفونونو سره همغږي فعاله ده.",
  "vaultPairScan.toast.pairedNearby": "ونښلول شو؛ اوس له نږدې همغږي کېږي",
  "vaultPairScan.toast.joinedSyncing": "یوځای شو؛ په شالید کې همغږي کېږي",
  "vaultPairScan.connecting.headline": "اوس پرېږدئ چې هغه ستاسو کوډ سکین کړي",
  "vaultPairScan.connecting.body":
    "دا {name} ته وښایئ. کله چې یې په خپل ټیلیفون سکین کړي، نښلول بشپړېږي.",
  "vaultPairScan.connecting.status": "نښلېږي…",
  "vaultPairScan.awaiting.headline": "بل ټیلیفون ته په تمه دی",
  "vaultPairScan.awaiting.body":
    "له {name} څخه وغواړئ چې دا کوډ په خپل ټیلیفون سکین کړي؛ د هغه په مخ کې هم کمره شته. کله چې یې سکین کړي، نښلول بشپړېږي.",
  "vaultPairScan.awaiting.hostHeadline": "له بل ټیلیفون سره اړیکه ټینګه نه شوه",
  "vaultPairScan.awaiting.hostBody":
    "ډاډ ترلاسه کړئ چې بل ټیلیفون لا هم خپل کوډ ښيي، بلوتوث فعال دی او ټیلیفونونه نږدې دي. بیا هڅه وکړئ.",
  "vaultPairScan.error.headline": "نښلول ونه شول",
  "vaultPairScan.error.signInRequired": "لومړی د بل ټیلیفون په هماغه حساب ننوځئ.",
  "vaultPairScan.error.accountMismatch":
    "دا کوډ د بل حساب لپاره جوړ شوی دی. له مالک څخه وغواړئ چې پر ځای یې د برېښنالیک بلنه درولېږي.",
  "vaultPairScan.error.generic": "نښلول ناکام شول",
  "vaultPairScan.error.expired":
    "د دې نښلولو کوډ موده پای ته رسېدلې ده. له مالک څخه وغواړئ چې نوی کوډ جوړ کړي.",
  "vaultPairScan.error.unsupported":
    "دا کوډ د کاټې له نوې نسخې څخه دی. اپ تازه کړئ او بیا هڅه وکړئ.",
  "vaultPairScan.error.malformed":
    "دا کوډ لوستل نه شو. ډاډ ترلاسه کړئ چې د کاټې د نښلولو کوډ مو سکین کړی دی.",
  "vaultPairScan.error.scannedJoinCode":
    "دا د بل ټیلیفون د یوځای کېدو کوډ دی. په هغه ټیلیفون کې چې کاټه لري، کاټه پرانیزئ ← غړي ← غړی ورزیات کړئ، بیا هغه کوډ سکین کړئ.",
  "vaultPairScan.split.hint": "کوډ په هغه ټیلیفون کې سکین کړئ چې کاټه لري.",
  "vaultPairScan.split.yourCode": "ستاسو کوډ (چې تاسو ورزیات کړي)",
  "vaultPairScan.split.theirCode": "د کاټې کوډ",
  "vaultPairScan.confirm.asRole": "د {role} په توګه",
  "vaultPairScan.confirm.roleMissing":
    "په دې کوډ کې واک نه دی ټاکل شوی؛ د سمونګر په توګه یوځای کېږئ.",
  "pairLink.title": "ټیلیفونونه ونښلوئ",
  "pairLink.unsupported.title": "کوډ په مخامخ ډول سکین کړئ",
  "pairLink.unsupported.body":
    "د لینک له لارې نښلول نور نه کېږي. له مالک څخه وغواړئ چې د نښلولو QR کوډ دروښيي او کله چې یو بل ته نږدې یاست، په دې ټیلیفون یې سکین کړئ.",
  "pairLink.signin.body": "د نښلولو د بشپړولو لپاره د بل ټیلیفون په هماغه حساب ننوځئ.",
  "pairLink.confirm.title": "له {name} سره یوځای کېږئ؟",
  "pairLink.confirm.body":
    "دا ټیلیفون به د کاټې دویمه وسیله شي. ستاسو راکړې ورکړې به د انټرنېټ له لارې، او کله چې دواړه ټیلیفونونه په یوه وای‌فای وي، نېغ په نېغه همغږي کېږي.",
  "pairLink.confirm.fromAccount": "له {id} حساب څخه…",
  "pairLink.joined.title": "ورسره ونښلول شو:\n{name}",
  "pairLink.joined.body":
    "دواړه ټیلیفونونه به اوس په یوه وای‌فای کې همغږي کېږي. د دوکان حالت فعال دی.",
  "pairLink.error.missingData":
    "په دې نښلولو لینک کې معلومات کم دي. له مالک څخه وغواړئ چې بیا یې درولېږي.",
  "pairLink.error.expired":
    "د دې نښلولو لینک موده پای ته رسېدلې ده. له مالک څخه وغواړئ چې نوی لینک جوړ کړي.",
  "pairLink.error.malformed":
    "دا نښلولو لینک ناسم دی. ډاډ ترلاسه کړئ چې له اصلي پیغام څخه مو پرانیستی دی.",
  "pairLink.error.accountMismatch":
    "دا لینک د بل حساب لپاره جوړ شوی دی. له مالک څخه وغواړئ چې پر ځای یې د برېښنالیک بلنه درولېږي.",
  "restore.confirm.title": "له کلاوډ څخه یې بېرته را وګرځوو؟",
  "restore.confirm.body":
    "په دې ټیلیفون کې به ټول معلومات ستاسو د کلاوډ په کاپي بدل شي. دلته شوي هر هغه بدلونونه چې تراوسه همغږي شوي نه دي، له منځه ځي.",
  "restore.confirm.cta": "د ټیلیفون معلومات بدل کړئ",
  "restore.confirm.cancel": "لغوه کړئ",
  "restore.toast.noBackup": "د دې حساب لپاره د کلاوډ بیک‌اپ ونه موندل شو.",
  "restore.toast.success": "له کلاوډ څخه بېرته راوګرځول شوه.",
  "restore.toast.successVaults": "{count} کاټې له کلاوډ څخه بېرته راوګرځول شوې.",
  "restore.toast.sessionExpired": "له حسابه وتلي یاست. د بېرته راګرځولو لپاره بیا ننوځئ.",
  "restore.toast.timeout": "د بېرته راګرځولو وخت پای ته ورسېد. خپله اړیکه وګورئ.",
  "restore.toast.generic": "بېرته راګرځول ناکام شول.",
  "restoreProgress.preparing": "چمتو کېږي…",
  "restoreProgress.finding": "ستاسو کاټې لټول کېږي…",
  "restoreProgress.vault": "له {total} څخه {current} کاټه بېرته راګرځول کېږي…",
  "restoreProgress.vaultOne": "ستاسو کاټه بېرته راګرځول کېږي…",
  "restoreProgress.finishing": "بشپړېږي…",
  "vaultNew.title": "خپلې کاټې ته نوم ورکړئ",
  "vaultNew.titleForced": "د دوام لپاره د خپلې کاټې نوم ولیکئ",
  "vaultNew.name.label": "د کاټې نوم",
  "vaultNew.name.placeholder": "لکه شخصي یا کاروباري",
  "vaultNew.name.required": "نوم اړین دی",
  "vaultNew.currency.label": "اصلي اسعار",
  "vaultNew.currency.hint":
    "د نویو راکړو ورکړو اصلي اسعار. په همدې کاټه کې د نورو اسعارو بیلانسونه جلا ساتل کېږي.",
  "vaultNew.localOnlyHint":
    "حساب ته نه یاست ننوتلي. تر ننوتلو پورې به دا کاټه یوازې په دې ټیلیفون کې وي.",
  "vaultNew.submit": "کاټه جوړه کړئ",
  "vaultNew.created": "{name} جوړه شوه",
  "vaultNew.failed": "کاټه جوړه نه شوه",
  "vaultSettings.title": "د کاټې تنظیمات",
  "vaultSettings.role.owner": "مالک",
  "vaultSettings.role.manager": "مدیر",
  "vaultSettings.role.editor": "سمونګر",
  "vaultSettings.role.clerk": "کارکوونکی",
  "vaultSettings.role.viewer": "کتونکی",
  "vaultSettings.section.details": "معلومات",
  "vaultSettings.section.members": "غړي",
  "vaultSettings.section.activity": "فعالیتونه",
  "vaultSettings.section.danger": "حساس کارونه",
  "vaultSettings.section.membership": "غړیتوب",
  "vaultSettings.name.label": "د کاټې نوم",
  "vaultSettings.name.required": "نوم اړین دی",
  "vaultSettings.name.save": "خوندي کړئ",
  "vaultSettings.currency.label": "اصلي اسعار",
  "vaultSettings.currency.hint":
    "د نوو راکړو ورکړو لپاره په خپله ټاکل کېږي. هره خوندي شوې راکړه ورکړه خپل اسعار ساتي.",
  "vaultSettings.currencies.label": "د دې کاټې اسعار",
  "vaultSettings.currencies.search": "اسعار ولټوئ",
  "vaultSettings.currencies.limit":
    "تاسو تر ۶۴ پورې اسعار فعالولی شئ. د نورو اسعارو د زیاتولو لپاره یو غیر فعال کړئ.",
  "vaultSettings.currencies.hint":
    "د نوو راکړو ورکړو اسعار وټاکئ. د اصلي اسعارو لپاره ستوری ووهئ. پخوانۍ راکړې ورکړې خپل اسعار ساتي.",
  "vaultSettings.currencies.default": "اصلي اسعار",
  "vaultSettings.currencies.defaultSummary": "اصلي: {currency}",
  "vaultSettings.currencies.selectedCount": "{count} ټاکل شوي",
  "vaultSettings.currencies.setDefault": "{currency} اصلي وټاکئ",
  "vaultSettings.currencies.changed":
    "د اسعارو امستنې بدلې شوې. دا لړ وتړئ او بیا یې پرانیزئ چې وروستي انتخابونه وګورئ.",
  "vaultSettings.viewOnly": "یوازې یې کتلی شئ؛ د مالک اجازه اړینه ده.",
  "vaultSettings.toast.noActive": "فعاله کاټه نشته",
  "vaultSettings.toast.notFound": "کاټه ونه موندل شوه",
  "vaultSettings.toast.loadFailed": "کاټه راوړل نه شوه",
  "vaultSettings.toast.saved": "د کاټې نوم بدل شو",
  "vaultSettings.toast.saveFailed": "نوم خوندي نه شو. بیا هڅه وکړئ.",
  "vaultSettings.toast.currencyUpdated": "پیسه بدله شوه",
  "vaultSettings.toast.currencyFailed": "پیسه بدله نه شوه",
  "vaultSettings.toast.archived": "کاټه آرشیف شوه",
  "vaultSettings.toast.archiveFailed": "آرشیف کول ناکام شول",
  "vaultSettings.archive.success": "کاټه آرشیف شوه",
  "vaultSettings.archive.successSwitched": "{old} آرشیف شوه. {name} ته واوښتئ.",
  "vaultSettings.archive.successNeedNew": "کاټه آرشیف شوه. د دوام لپاره نوې کاټه جوړه کړئ.",
  "vaultSettings.archive.successNeedRestore":
    "کاټه آرشیف شوه. د دوام لپاره یوه کاټه بېرته را وګرځوئ.",
  "vaultSettings.toast.left": "له کاټې ووتئ",
  "vaultSettings.toast.leaveFailed": "وتل ناکام شول",
  "vaultSettings.row.members": "غړي",
  "vaultSettings.row.members.hint.one": "۱ کس",
  "vaultSettings.row.members.hint.many": "{count} کسان",
  "vaultSettings.row.invite": "غړي ته بلنه ورکړئ",
  "vaultSettings.row.invite.hint": "د برېښنالیک له پتې سره تړلې بلنه",
  "vaultSettings.row.addPhone": "ټیلیفون ورزیات کړئ",
  "vaultSettings.row.addPhone.hint": "خپل بل ټیلیفون ونښلوئ",
  "vaultSettings.row.audit": "د فعالیتونو تاریخچه وګورئ",
  "vaultSettings.row.audit.hint.owner": "د کاټې ټول فعالیتونه",
  "vaultSettings.row.audit.hint.editor": "ستاسو کړنې",
  "vaultSettings.row.audit.viewerEmpty": "د فعالیتونو تاریخچه د کتونکو لپاره نه ده چمتو.",
  "vaultSettings.row.transfer": "مالکیت ولېږدوئ",
  "vaultSettings.row.leave": "له کاټې ووځئ",
  "vaultSettings.row.archive": "کاټه ارشیف کړئ",
  "vaultSettings.row.unarchive": "کاټه له ارشیفه راوباسئ",
  "vaultSettings.toast.unarchived": "کاټه له ارشیفه راوایستل شوه",
  "vaultSettings.toast.unarchiveFailed": "له ارشیفه راوایستل نه شوه. بیا هڅه وکړئ.",
  "vaultSettings.confirm.archive.title": "دا کاټه ارشیف کړئ؟",
  "vaultSettings.confirm.archive.body":
    "دا کاټه به له ټولو هغو کسانو پټه شي چې لاسرسی ورته لري. د څو خاوندانو کاټه باید تر بشپړ ړنګېدو مخکې د ټولو خاوندانو له خوا ارشیف شي. د 30 ورځو د مهلت تر تېرېدو وروسته دا کار بېرته نه شي ګرځېدای.",
  "vaultSettings.confirm.archive.cta": "ارشیف کړئ",
  "vaultSettings.confirm.leave.title": "له دې کاټې ووځئ؟",
  "vaultSettings.confirm.leave.body.owner":
    "تاسو خاوند یاست. که یوازینی خاوند یاست، درڅخه به وغوښتل شي چې مالکیت بل چا ته وسپارئ یا دا کاټه ارشیف کړئ.",
  "vaultSettings.confirm.leave.body.member":
    "دې کاټې ته به ستاسو لاسرسی پای ته ورسېږي. خاوند وروسته بیا بلنه درکولای شي.",
  "vaultSettings.confirm.leave.cta": "ووځئ",
  "vaultSettings.leave.lastOwner.title": "تاسو یوازینی خاوند یاست",
  "vaultSettings.leave.lastOwner.body":
    "که ووځئ، دا کاټه به سمبالوونکی ونه لري. وروسته به نه شئ کولای څوک راوبلئ، امستنې بدلې کړئ یا یې ارشیف کړئ. پر ځای یې ارشیف کړئ، یا لومړی مالکیت یوه غړي ته وسپارئ.",
  "vaultSettings.leave.lastOwner.archive": "پر ځای یې ارشیف کړئ",
  "vaultSettings.leave.lastOwner.transfer": "مالکیت وسپارئ",
  "vaultSettings.leave.lastOwner.cancel": "لغوه کړئ",
  "vaultSettings.confirm.transfer.title": "مالکیت وسپارئ؟",
  "vaultSettings.confirm.transfer.body":
    "بل غړی د نوي خاوند په توګه وټاکئ. ستاسو ونډه به سمونګر ته بدله شي، مګر که د وتلو پرېکړه هم وکړئ.",
  "vaultSettings.confirm.transfer.cta": "غړی وټاکئ",
  "vaultSettings.section.export": "صادرول",
  "vaultSettings.row.export": "کاټه صادره کړئ",
  "vaultSettings.row.export.hint": "PDF · CSV",
  "vaultSettings.export.sheetTitle": "کاټه صادره کړئ",
  "vaultSettings.toast.exportFailed": "صادره نه شوه. بیا هڅه وکړئ.",
  "vaultSettings.section.people": "کسان",
  "vaultSettings.row.removedPeople": "لرې شوي کسان",
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "له {accountWith} سره ستاسو کاټه:",
  "share.theyOwe.amount": "🔴 ستاسو پور: −{amount} {currency}",
  "share.theyOwe.cta": "مهرباني وکړئ چې وس مو وشو، حساب تصفیه کړئ.",
  "share.youOwe.header": "زموږ کاټه:",
  "share.youOwe.amount": "🟢 ستاسو پر ما پور: +{amount} {currency}",
  "share.youOwe.cta": "ژر به حساب تصفیه کړم.",
  "share.settled.line": "🤝 زموږ د کاټې حساب په بشپړه توګه تصفیه دی.",
  "share.settled.cta": "مننه.",
  "share.footer": "— د www.kaata.af له لارې لېږل شوی",
  "share.fullLedger": "بشپړ حساب کتاب دلته وګورئ:",
  "share.currencySettled": "🤝 {currency}: تصفیه شوی.",
  "share.billUnavailable": "بشپړ حساب کتاب ورسره ونه نښلول شو. دا یوازې بیلانسونه دي.",
  "share.askLang.title": "په کومه ژبه یې ولېږو؟",
  "brand.wordmark": "کاټه.",
  "format.justNow": "همدا اوس",
  "format.minutesAgo": "{n} دقیقې مخکې",
  "format.hoursAgo": "{n} ساعته مخکې",
  "format.yesterday": "پرون",
  "format.daysAgo": "{n} ورځې مخکې",
  "format.weeksAgo": "{n} اوونۍ مخکې",
  "format.am": "له غرمې مخکې",
  "format.pm": "له غرمې وروسته",
  "fgs.channelName": "له نږدې ټیلیفونونو سره همغږي",
  "fgs.channelDescription":
    "هغه مهال ښکاري چې کاټه ستاسو حساب کتاب له نږدې ټیلیفونونو سره همغږی ساتي.",
  "fgs.title": "له نږدې ټیلیفونونو سره همغږي فعاله ده",
  "fgs.waiting": "د کاټې د پرانیستلو لپاره ووهئ",
  "fgs.connectedOne": "له ۱ نږدې ټیلیفون سره نښتی دی",
  "fgs.connectedMany": "له {count} نږدې ټیلیفونونو سره نښتی دی",
  "share.whatsappUnavailable": "واټس‌اپ پرانیستل نه شو. په دې ټیلیفون کې نصب دی؟",
  "diagnostics.title": "د اپ روغتیا",
  "diagnostics.hint":
    "څه کار نه کوي؟ «ملاتړ ته یې ولېږئ» ووهئ — واټساپ به له دې چمتو راپور سره پرانیستل شي، څو ستونزه ووینو او سمه یې کړو. یا یې کاپي او پخپله راولېږئ.",
  "diagnostics.copyReport": "راپور کاپي کړئ",
  "diagnostics.copying": "کاپي کېږي…",
  "diagnostics.copied": "کاپي شو ✓",
  "diagnostics.sendToSupport": "ملاتړ ته یې ولېږئ",
  "diagnostics.support.intro": "سلام کاټه — په اپ کې څه کار نه کوي. دا زما د اپ د روغتیا راپور دی.",
  "diagnostics.toast.copied": "کاپي شو — اوس یې په واټساپ کې راولېږئ",
  "diagnostics.toast.copyFailed": "په خپله کاپي نه شو — لاندې متن کاپي کړئ",
  "diagnostics.toast.sendFailed": "واټساپ پرانیستل نه شو — راپور کاپي او راولېږئ",
  "diagnostics.fallbackHint": "لاندې متن اوږد ونیسئ ← ټول وټاکئ ← کاپي کړئ، بیا یې راولېږئ.",
  "diagnostics.section.version": "نسخه",
  "diagnostics.staleBuild":
    "⚠ د اپ دننه JS {js} ≠ اصلي نسخه {native} — پخوانۍ نسخه روانه ده؛ وروستی APK بیا نصب کړئ.",
  "diagnostics.section.exits": "اپ ولې بند شو (تر ټولو نوی لومړی)",
  "diagnostics.noExits": "د بندېدو ریکارډ نشته (Android < 11، یا نوی نصب چې مخکې نه دی بند شوی).",
  "diagnostics.section.now": "همدا اوس",
  "diagnostics.refresh": "تازه کړئ",
  "export.action.sharePdf": "د PDF په بڼه یې شریک کړئ",
  "export.action.shareCsv": "د CSV په بڼه یې شریک کړئ",
  "export.action.savePdf": "PDF په ټیلیفون کې خوندي کړئ",
  "export.action.saveCsv": "CSV په ټیلیفون کې خوندي کړئ",
  "export.saved": "{name} خوندي شو",
  "export.savedDownloads": "د {name} په نوم په ډاونلوډونو کې خوندي شو",
  "export.doc.statementTitle": "د حساب پاڼه",
  "export.doc.summaryTitle": "د کاټې راپور",
  "export.doc.generated": "په {date} جوړ شو",
  "export.doc.peopleCount": "{n} کسان",
  "export.doc.entriesCount": "{n} راکړې ورکړې",
  "export.doc.totalCollect": "ټولې اخیستل کېدونکې پیسې",
  "export.doc.totalPay": "ټولې ورکول کېدونکې پیسې",
  "export.doc.net": "خالص",
  "export.doc.balance": "پاتې حساب",
  "export.doc.empty": "تر اوسه راکړه ورکړه نشته.",
  "export.doc.customer": "پېرودونکی",
  "export.doc.preparedBy": "چمتو کوونکی",
  "export.doc.summarySection": "د حساب لنډیز",
  "export.doc.transactionsSection": "راکړې ورکړې",
  "export.doc.peopleSection": "کسان",
  "export.doc.totalGave": "ټول ورکړل شوي",
  "export.doc.totalReceived": "ټول ترلاسه شوي",
  "export.doc.settledOn": "په {date} تصفیه شو",
  "export.doc.clearedBy": "د {name} له خوا په {date} تصفیه شو",
  "export.doc.clearedUnnamed": "په {date} تصفیه شو (نوم نه دی ثبت شوی)",
  "export.col.date": "نېټه",
  "export.col.dateShamsi": "نېټه (شمسي)",
  "export.col.dateQamari": "نېټه (قمري)",
  "export.col.person": "نوم",
  "export.col.phone": "ټیلیفون",
  "export.col.note": "یادښت",
  "export.col.gave": "ورکړل",
  "export.col.received": "ترلاسه کړل",
  "export.col.balance": "پاتې حساب",
  "export.col.entries": "راکړې ورکړې",
  "export.col.num": "#",
  "export.col.amount": "مبلغ",
  "export.col.type": "ډول",
  "export.col.status": "حالت",
  "export.col.lastActivity": "وروستی فعالیت",
  "export.col.id": "د راکړې ورکړې پېژند",
  "export.record.title": "د ثبت شویو منلو سره ګډ ریکارډ",
  "export.record.explanation":
    "په پاتې حساب کې تایید شوې ګډې راکړې ورکړې او دلته جلا ښودل شوي شخصي ثبتونه شمېرل کېږي. په تمه خالص بدلون هغه تایید شوی پاتې حساب بیا نه شمېري چې وړاندیز شوي لومړني پاتې حساب ته لېږدول شوی وي. په تمه مبلغونه تایید شوی پور نه دی. رد شوي او لغوه شوي ثبتونه صفر شمېرل کېږي. د بیاکتونکي ورک جزییات نه دي ثبت شوي. نومونه د حساب نومونه دي، تایید شوي قانوني هویتونه نه دي.",
  "export.record.acknowledgedBalance": "منل شوی خالص پاتې حساب",
  "export.record.pendingBalance": "په تمه خالص بدلون",
  "export.record.privateBalance": "شخصي خالص پاتې حساب",
  "export.record.contribution": "پر پاتې حساب اغېز",
  "export.record.status": "د ریکارډ حالت",
  "export.record.pending": "په تمه",
  "export.record.accepted": "ومنل شوه",
  "export.record.rejected": "رد شوه",
  "export.record.cancelled": "لغوه شوه",
  "export.record.private": "شخصي راکړه ورکړه",
  "export.record.sync": "د همغږۍ حالت",
  "export.record.awaitingSync": "د همغږۍ په تمه",
  "export.record.acceptanceAwaitingSync": "منل د همغږۍ په تمه دي",
  "export.record.rejectionAwaitingSync": "ردول د همغږۍ په تمه دي",
  "export.record.cancellationAwaitingSync": "لغوه کول د همغږۍ په تمه دي",
  "export.record.saved": "په سرور کې ثبت شوې",
  "export.record.tabId": "د ګډ حساب پېژند",
  "export.record.author": "زیاتوونکی",
  "export.record.authorId": "د زیاتوونکي د حساب مرجع",
  "export.record.authorRole": "د زیاتوونکي د هماغه وخت ونډه",
  "export.record.recordedAt": "د ثبت وخت (UTC)",
  "export.record.reviewer": "بیاکتونکی",
  "export.record.reviewerId": "د بیاکتونکي د حساب مرجع",
  "export.record.reviewerParty": "د بیاکتونکي لوری",
  "export.record.reviewerRole": "د بیاکتونکي د هماغه وخت ونډه",
  "export.record.reviewedAt": "د بیاکتنې وخت (UTC)",
  "export.record.reviewVersion": "د بیاکتنې د کړنې نسخه",
  "export.record.reason": "د ردولو لامل",
  "export.record.cancelledBy": "لغوه کوونکی",
  "export.record.cancelledById": "د لغوه کوونکي حساب مرجع",
  "export.record.cancelledAt": "د لغوه کولو وخت (UTC)",
  "export.record.cancellationId": "د لغوه کولو د ریکارډ پېژند",
  "export.record.seq": "د ریکارډ لړۍ",
  "export.record.rev": "د ریکارډ سمون",
  "export.record.unknown": "نه دی ثبت شوی",
  "export.record.closedDeleted":
    "د یوه حساب د ړنګېدو له امله وتړل شو. ګډ ریکارډ یوازې د لیدلو لپاره دی.",
  "export.record.archiveTitle": "پخوانۍ ګډه دوره",
  "export.preLinkHistory.title": "تر نښلولو مخکې شخصي مخینه",
  "export.preLinkHistory.note":
    "یوازې د مخینې لپاره دي. د دې ریکارډونو پاتې حساب لا دمخه د پیل په راکړه ورکړه کې لېږدول شوی او په اوسني ټولیز حساب کې نه شمېرل کېږي.",
  "export.record.beforeLink": "تر نښلولو مخکې — په اوسني پاتې حساب کې نه شمېرل کېږي",
  "export.record.archiveExplanation":
    "یوازې د پخوانۍ مخینې ثبوت دی. دا دوره په اوسني پاتې حساب کې نه شمېرل کېږي؛ لېږدول شوی مبلغ یې په یوې وروسته پیل شوې راکړه ورکړه کې ښودل کېږي. د لاندې دورې پاتې حساب په همدې پخواني حساب پورې تړاو لري.",
  "export.record.scope": "د پاتې حساب محدوده",
  "export.record.current": "اوسنۍ حساب پاڼه",
  "export.record.archived": "پخوانۍ ګډه دوره — په اوسني پاتې حساب کې نه شمېرل کېږي",
  "export.record.currency": "د پیسو ډول",
  "export.record.periodBalance": "د پخوانۍ دورې پاتې حساب",
  "export.record.recordedAmount": "ثبت شوی مبلغ",
  "export.record.role.account": "د حساب خاوند",
  "export.record.side.this": "دا لوری",
  "export.record.side.other": "بل لوری",
  "settings.language.option.ps": "پښتو",
};

const TABLES = { en, fa, ps } as const;
export type LocaleCode = keyof typeof TABLES;

// Active locale, computed once at module load. The current launch's strings
// reflect this. When we add a manual override toggle, this will read from
// app_meta first.
/** Supported language tags, independent of text direction and the chosen calendar. */
export function localeFromLanguageTag(tag: string | null | undefined): LocaleCode | null {
  const language = (tag ?? "").trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  if (language === "fa" || language === "prs") return "fa";
  if (language === "ps") return "ps";
  return language === "en" ? "en" : null;
}

function pickLocale(): LocaleCode {
  const first = getLocales()[0];
  return localeFromLanguageTag(first?.languageCode ?? first?.languageTag) ?? "en";
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
  return currentLocale === "fa" || currentLocale === "ps";
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
    if (pref === "en" || pref === "fa" || pref === "ps") {
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
    return v === "ask" || v === "en" || v === "fa" || v === "ps" ? v : "auto";
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
 * ensureLocalSelfForRestore ("You"/"شما"/"تاسو") rather than a name the user or
 * their sign-in provider actually supplied. Checked against all supported locales'
 * literals — the mint uses the active UI locale, but the user may switch
 * languages later. Callers use this to avoid propagating the placeholder
 * into signed events, member mirrors, or WhatsApp-visible surfaces.
 */
export function isPlaceholderSelfName(name: string): boolean {
  const trimmed = name.trim();
  return Object.keys(TABLES).some(
    (locale) => trimmed === tIn(locale as LocaleCode, "recovery.selfPlaceholderName"),
  );
}

// Re-evaluate the locale after the user (eventually) toggles a manual
// override. Currently device-driven only.
export function refreshLocale(): void {
  currentLocale = pickLocale();
}
