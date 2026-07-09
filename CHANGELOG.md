# Changelog

## 0.8.5 — 2026-07-09

The first Play Store release. A large hardening + compliance pass on top of
0.8.4, plus onboarding polish. (Offline Nearby/Bluetooth sync is parked in this
build and ships in a later update.)

### New
- **Sign in with Apple** (iOS) — a privacy-focused login option alongside Google.
- **Delete your account** — Settings → Delete account removes your account and
  all data backed up to Kaata's servers, then clears the ledger on the phone.
- **Privacy Policy & Terms of Service** — published at kaata.af/privacy and
  kaata.af/terms and linked from inside the app.
- Onboarding polish: game-style completion, and a "kaata vs. tally" guide across
  onboarding, home, and settings.

### Fixed
- **Cloud restore** no longer reverts a synced phone to a stale backup — signing
  in / restoring on a device that already has your ledger can't drop your recent
  entries anymore.
- The **currency symbol now follows the active kaata** — picking USD (or any
  non-AFN currency), creating a second kaata, or switching kaatas no longer
  leaves amounts (and WhatsApp reminders / shared links) labelled with the wrong
  currency.
- **Pasted amounts** like `25,000` are no longer silently truncated to `25`.
- **Large font sizes**: the home total and person balance no longer wrap
  mid-number (e.g. `1,234,567` → `1,234,5` / `67`), and long customer names keep
  a usable width in the list.
- **Edit screens** no longer get stuck on a blank spinner if a read fails.
- Double-tapping the WhatsApp reminder or an invite no longer fires twice
  (duplicate share links / accept errors).
- A wrong "phone already used" error on the account screen now reads as a plain
  save error.
- Several sync/projection correctness fixes so the ledger stays consistent across
  devices (sticky deletes, out-of-order edits, shop-name updates on a joined
  kaata, clock-skew protection).
- "Reset all data" now clears leftover trust credentials + diagnostics.

### Privacy & security
- Your own name/phone/shop are uploaded **only when you're signed in** — an
  offline install sends nothing personal.
- Closed a way a shared-kaata member could forge owner-level changes on the server.
- Server hardening: request-size caps, read/write/idle timeouts, DB pool +
  statement-timeout limits, Google token issuer check, account-bound session
  revocation, and no longer trusting spoofable client-IP headers.
- Web: security headers (CSP, HSTS, etc.), removed a path that could ship the
  admin key in the public bundle, and stopped invite tokens leaking into
  analytics.
- Crash reports are ring-capped so they can't grow without bound on a device
  that can't reach the server.

### Under the hood
- **Removed the parked Nearby-sync background service** and its
  `FOREGROUND_SERVICE_CONNECTED_DEVICE` + battery-optimization permissions for
  this release (fewer permissions, cleaner Play review).
- Accessibility: toasts announce to screen readers, dialog buttons are labelled,
  home tabs hit the 44dp touch target.
- Removed root `eas.json`/`app.json` decoys that could produce a wrong-keystore
  build; tightened `.gitignore` around secrets; export-compliance key for iOS.

Full detail per change: `git log v0.8.4..v0.8.5` and `docs/prod-readiness-remaining.md`
for what's intentionally deferred.

## 0.8.4 and earlier

See the release tags (`v0.8.0`–`v0.8.4`) and Git history.
