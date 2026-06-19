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
- [ ] **C5** Contacts are "one with" the phone book, WhatsApp-style:
      - adding a contact in the app also writes it to the phone's contacts;
      - new/changed phone contacts reflect in the app in real time;
      - but do NOT list every phone contact on the main page (only tallied ones — see C2).

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

### Status log (updated as I go)
- (start) Audit done; A1–A5 shipped; screenshot of C1 reviewed; investigation workflow launching.
