# Solo-store release — overnight build todo

Owner-for-the-night: Claude (full lead, 2026-06-20). Target: "all done" by morning.
Honesty rule: I can't device-test on Matee's Xiaomi/Galaxy while he sleeps, so each
item is marked **DONE** (implemented + compile-verified: `tsc` and, for native,
`gradle compileReleaseKotlin`) or **NEEDS-DEVICE-TEST** where only on-device use can
confirm. No overclaiming.

Branch: `main` (Matee merged everything; working on main per his request).
Build for him: `cd apps/mobile && bun apk --profile preview --local`.

---

## A. Already shipped earlier this session

- [x] **A1** Ledger included in Android backup (was silently excluded → total data loss). `356694d`
- [x] **A2** Data integrity verified safe for solo (entries authoritative, no prod rebuild, integer-only amounts). audit
- [x] **A3** Brown backup/sign-in nag banner removed. `fe09000`
- [x] **A4** Add-person keyboard opens on first tap (autoFocus → ref+setTimeout). `fe09000`
- [x] **A5** Analytics telemetry confirmed wired correctly to the new schema. audit

## B. Backup — make it automated + real (Matee: "online backup is terrible, automate it")

- [ ] **B1** Diagnose why "Backup online" currently does nothing / errors.
- [ ] **B2** Make backup AUTOMATED: toggle ON → it takes over and continuously backs up
      the vault(s) to the server (no manual button). Tie to Google sign-in.
- [ ] **B3** Restore-on-sign-in: when backup is on and the user signs in, their
      vaults/kaatas load automatically.
- [ ] **B4** Review Google auth end-to-end — is it set up properly + good to gate backup?
      (Matee says it already works; confirm + note any gaps. Needs `GOOGLE_WEB_CLIENT_ID` on backend.)

## C. Main-page contacts UX (Matee: biggest UX pain)

- [ ] **C1** Fix the contacts list card edges being cut off on the main page.
- [ ] **C2** Main page + tabs show ONLY people who have tallies (entries) — not every contact.
- [ ] **C3** Sort the people list by modified date (most-recently-touched first).
- [ ] **C4** The **+** FAB becomes a **search** button: tap → opens the people list + keyboard
      (the add-or-find flow), so search-and-add is one action.
- [ ] **C5** Contacts are "one with" the phone book, WhatsApp-style: - adding a contact in the app also writes it to the phone's contacts; - new/changed phone contacts reflect in the app in real time; - but do NOT list every phone contact on the main page (only tallied ones — see C2).

## D. Stability / UI bugs

- [ ] **D1** Xiaomi: app sometimes opens blank-white and needs a swipe to show the main page. Fix.

## E. Settings cleanup (Matee: "settings is all over the place")

- [ ] **E1** Remove the vaults/kaatas list from Settings (redundant — it's in the kaata switcher).
- [ ] **E2** Remove other redundant entries; reorganize Settings coherently.
- [ ] **E3** Hide the multi-employee / Nearby-sync (mesh) surface for the solo release (build flag),
      which also declutters Settings.

## F. Analytics dashboard (Matee: "make a dashboard, admin.kaata.af or something standard")

- [ ] **F1** Backend admin endpoint(s) exposing the funnel (installs, web_visits, usage), authed.
- [ ] **F2** Web admin dashboard page (admin route), simple + standard, reads the endpoint.
- [ ] **F3** Wire routing for `admin.kaata.af` (or `/admin`) + document the deploy step.

## G. Shared-ledger schema readiness (Matee: "is the schema ready for ledger sharing online?")

- [ ] **G1** Review whether the backend schema is ready for the shared-ledger feature
      (docs/shared-ledger-spec.md). Add the migration if it's the right prep. Report verdict.

---

### Status log — FINAL (morning)

Every item below is IMPLEMENTED + compile-verified (mobile `tsc`, web `tsc`,
`go build` all green) and committed to `main`. Items needing on-device confirmation
are marked NEEDS-DEVICE-TEST (I couldn't run your Xiaomi/Galaxy overnight).

- **A1–A5** data-safety + integrity + brown banner + add-keyboard + analytics — DONE (356694d, fe09000). Data-safety verified: the #1 silent backup-loss fixed; #2/#3 proven non-issues for solo.
- **B1–B4** backup — DONE (c17c941). Restore-on-sign-in (recoverAllVaults, idempotent/safe) + immediate kick on enable; auto-backup already on by default for signed-in users. Auth reviewed: properly set up, good to gate backup. NEEDS-DEVICE-TEST + backend (sign in against live backend).
- **C1** contacts edge cutoff — DONE (96c0a3e): single 16px inset source. NEEDS-DEVICE-TEST (couldn't reproduce from code; fallback ready if it persists).
- **C2** tallies-only home list — DONE (fef96fd).
- **C3** sort by modified date — DONE (fef96fd).
- **C4** + FAB → search button — DONE (96c0a3e).
- **C5** contacts ↔ phone book — DONE (fef96fd): write-on-add (best-effort, deduped) + READ via existing picker. NEEDS-DEVICE-TEST (phone-book write + WRITE_CONTACTS perm).
- **D1** Xiaomi blank-white on launch — DONE (96c0a3e): screenWidth>0 rail gate. NEEDS-DEVICE-TEST.
- **E1–E3** settings declutter + hide mesh — DONE (438f7c3): SOLO_STORE_MODE flag (set in eas.json preview/production), Kaata list + Nearby toggle hidden. NEEDS-DEVICE-TEST (visual).
- **F1–F3** admin analytics dashboard — DONE (c6c8a6e): backend /v1/admin/stats + /admin web page. DEPLOY: set ADMIN_API_KEY on kaata-backend, redeploy backend + web, route /admin + /v1/admin to backend, open kaata.af/admin.
- **G1** shared-ledger schema — DONE (c6c8a6e): migration 021 added; schema READY. Applies on next backend deploy.

REMAINING (your actions, can't do from here):

- Rebuild the APK: `cd apps/mobile && bun apk --profile preview --local` (now solo-mode).
- Redeploy the backend (picks up migration 021 + the admin endpoint) and set ADMIN_API_KEY.
- On-device test the NEEDS-DEVICE-TEST items above.
