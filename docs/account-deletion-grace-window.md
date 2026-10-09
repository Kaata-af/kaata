# Recoverable account deletion with a grace window — design

Status: DESIGN (not yet implemented). Written 2026-10-08 after the 2026-10-07 incident
where a shopkeeper tapped "Delete account" by accident and lost a year of ledger; recovery
required hand forensics (see the recovery kit under `apps/backend/scratch-reimport/`).
Goal: make account deletion reversible for a grace window so this cannot recur.

## 0. Findings that shape the design

- Today `DELETE /v1/account` → `Service.DeleteAccount` (`apps/backend/internal/auth/delete_account.go:46`)
  does everything in one tx: closes abandoned shared tabs (`:97-141`), retires installs + writes the
  receipt `account_deleted_at`/`deletion_account_id` (`:146-166`), then hard-deletes owned-vault events,
  owned vaults, memberships, device bindings, nulls `invited_by/revoked_by` and the unused
  `vaults.pending_delete_*`, and finally `DELETE FROM accounts` (`:168-180`).
- The vault archive→purge pattern is the template: grace constant `archiveGrace = 30 days`
  (`apps/backend/internal/vaults/archive_purge.go:66`), a cron scanning
  `archived_at < NOW()-30d AND purged_at IS NULL` (`:139-154`), per-row `FOR UPDATE SKIP LOCKED`
  hard-delete (`:183-277`), wired at `apps/backend/cmd/server/main.go:516`, reversible via `Unarchive`
  with a defense-in-depth grace recheck (`apps/backend/internal/vaults/service.go:685`).
- Sign-in resolves the account BEFORE the install-retire check, in one tx: `resolveOrCreateAccount`
  (`service.go:273`, returns a `created` bool currently discarded) then `ensureSignInInstall`
  (`service.go:295`; Apple `:505`/`:523`). This ordering is what makes in-tx cancellation possible.
- Access is already gated by two independent mechanisms: `auth_credentials.revoked_at` via
  `CheckCredentialRevoked` (`service.go:640`) feeding every middleware, and `installs.account_deleted_at`
  which makes check-in and sign-in return 410 (`apps/backend/internal/checkin/service.go:309,319`).
- The `DeletionMiddleware` revoked-branch confirms a completed deletion for lost-response retries via
  `AccountDeletionCompleted` (`middleware.go:97-106`, keyed on `NOT EXISTS account`).
- Migrations are filename-sorted, one tx each (`apps/backend/internal/db/db.go:93-128`); next number is
  **052**. Mobile migrations are append-only `runMigrationNNN` in `apps/mobile/lib/db.ts`, at **032**.
- Mobile already wipes locally after a confirmed server delete and rotates to a fresh install id
  (`apps/mobile/lib/auth.ts:1369-1397`, `clearDeletedAccountLocally`). Load-bearing below.

## 1. Backend schema + service

Migration `052_account_pending_delete.sql`:
```sql
ALTER TABLE accounts ADD COLUMN pending_delete_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN delete_requested_from_install UUID;
CREATE INDEX idx_accounts_pending_delete_queue
  ON accounts(pending_delete_at) WHERE pending_delete_at IS NOT NULL;
```
Leave the unused `vaults.pending_delete_by/at` scaffold in place but retired (append-only).

Split `delete_account.go` into request-time vs purge-time:
- `RequestAccountDeletion(accountID, installID)` — new body of `DELETE /v1/account`. Lock the account
  `FOR UPDATE`; if `pending_delete_at` already set, return idempotently. Otherwise: set
  `pending_delete_at=NOW()`, `delete_requested_from_install`; write the receipt + retire THIS account's
  installs (selector from `:146-151`) → blocks check-in/sign-in (410); `UPDATE auth_credentials SET
  revoked_at=NOW() WHERE account_id=$acct` (live JWTs 401 immediately; sign-in upsert un-revokes on
  return); `InvalidateAccount`. Do NOT delete vaults/events/memberships, do NOT close tabs, do NOT clear
  install identity/crash_reports, do NOT delete the accounts row — all destructive work defers to purge.
- `purgeOneAccount(accountID)` — cron worker containing today's destructive body verbatim, guarded by
  `FOR UPDATE SKIP LOCKED` + recheck `pending_delete_at IS NOT NULL AND pending_delete_at < NOW()-grace`
  (mirror `purgeOneVault`).

Access blocked while pending falls out of existing machinery (revoked creds → 401; `account_deleted_at`
→ 410). No new middleware required.

## 2. Cancellation / self-recovery

In `SignInWithGoogle`/`SignInWithApple`, capture the discarded `created` bool from
`resolveOrCreateAccount` and when `!created` call `cancelPendingDeletion(tx, accountID)` BEFORE
`ensureSignInInstall`:
```sql
UPDATE accounts SET pending_delete_at=NULL, delete_requested_from_install=NULL
  WHERE id=$acct AND pending_delete_at IS NOT NULL;   -- RowsAffected>0 ⇒ cancelled
-- if cancelled:
UPDATE installs SET account_deleted_at=NULL, deletion_account_id=NULL WHERE deletion_account_id=$acct;
```
Runs in the sign-in tx, so it lifts the current install's retirement before `ensureSignInInstall` reads
it — even the original device cancels in one shot, no reset needed. Covers every resolution path
(canonical identity, legacy `google_sub`, cross-provider verified-email link `identity.go:151-196`)
because it keys off the resolved `accountID`.

Tell the client: add `DeletionCancelled bool` to the sign-in result → `deletion_cancelled` in the auth
response. The client already runs `recoverAllVaults` on a returning sign-in (`recovery.ts:90`); the flag
only drives "your deletion was cancelled, data restored" messaging.

Idempotent DELETE retry: add `AccountDeletionState(installID, accountID) → (purged, scheduled, purgeAt)`
and extend `DeletionMiddleware`: on revoked, return `{"status":"deleted"}` when purged,
`{"status":"deletion_scheduled","purge_at":…}` when pending, else 401.

## 3. Mobile

- Keep the immediate local wipe + install-id rotation (`auth.ts:1369`). The server now holds the
  restorable copy; the rotation is what lets the same phone sign back in cleanly to cancel. **Consequence
  to state plainly: the phone looks empty right after the tap; recovery is sign-in-triggered, same as
  today — the grace window protects an accidental deleter who signs back in within 30 days.**
- `lib/account-deletion.ts`: accept `status === "deletion_scheduled"` as success alongside `"deleted"`.
- `lib/auth.ts`: add `deletion_cancelled?` to `AuthResponse`; in `installAuthResponse`, when true surface
  a welcome-back toast/screen and let the existing restore path run.
- `app/account.tsx`: confirm dialog copy stops saying permanent-now; same `deleteAccount()` call, only
  strings change.
- No mobile migration (033) needed — no new local tables; local DB is wiped+rebuilt on delete and
  repopulated by recovery. Deliberate.
- Copy (LTR-locked, Dari + English), replacing `i18n.ts:737`/`:2201`:
  - en: "Your account and everything in it will be scheduled for deletion. Cloud copies of kaatas you own
    and this phone's ledger are removed now; your account and its data are kept for 30 days and then
    permanently deleted. Sign in again within 30 days to cancel and restore everything. Other participants
    keep shared tally history. Deletion settles no balance."
  - fa: "حساب شما و همهٔ محتوای آن برای حذف زمان‌بندی می‌شود. نسخه‌های ابری کاتاهایی که مالک آن هستید و دفتر این تلفون همین حالا پاک می‌شوند؛ حساب و معلومات شما ۳۰ روز نگه داشته می‌شود و سپس برای همیشه حذف می‌گردد. برای لغو و بازگرداندن همه چیز، ظرف ۳۰ روز دوباره وارد شوید. طرف‌های دیگر سابقهٔ حساب مشترک را نگه می‌دارند. حذف حساب هیچ بیلانسی را تصفیه نمی‌کند."
  - Keep cta "Delete account"/"حذف حساب". Add `account.deleteAccount.cancelled.{title,body}`. Retired-install
    copy stays (applies to secondary devices and post-purge).

## 4. Store compliance

A grace/cooling-off window is permitted by both stores if the user is informed and deletion ultimately
completes:
- Apple App Review 5.1.1(v): in-app deletion required; a grace period before permanent deletion is allowed
  if disclosed. In-app path already exists (`account.tsx:539`).
- Google Play Account deletion requirements (Data safety): in-app request for account AND data deletion; a
  grace period is acceptable when disclosed. This also tightens the 2026-10-02 "Login credentials are
  missing" review risk: a reviewer who taps delete can sign back in and recover.
- Required wording (dialog + `kaata.af/privacy`): "Your account and data will be permanently deleted 30
  days after you request deletion. You can cancel any time within those 30 days by signing in again."

## 5. Vault deletion

No change — vaults already have 30-day archive→purge with unarchive. Account deletion is the only gap.
Recommendation: share one grace constant between the two crons. Leave (and document) that purging an owner
account still hard-deletes co-owned/shared owned vaults; transfer-on-delete is out of scope.

## 6. Window length

Recommend 30 days — matches `archiveGrace`, `DIFFERENT_ACCOUNT_WINDOW_MS` (`auth.ts:216`) and
`SessionLifetime` (`jwt.go:18`); within both stores' norms; reuses the archive cron's 6-hour cadence.
14 days is the acceptable floor.

## Risks / edge cases

- Delete then "new account, same email" within the window: signing in with the same identity or a
  different provider on the same verified email resolves the pending account and cancels it (cancel placed
  after resolution, covering the email-link path). A genuinely fresh account on the same email is only
  possible after purge.
- Shared vault where the deleter is a member (not owner): nothing in others' vaults is touched until purge;
  during the window the pending member is blocked by the revoke but still appears a member to others.
- Second device: install retired (410) and JWT 401s; recovery requires a re-sign-in (after "reset this
  phone" if it shows the retired notice), which cancels (if still pending) and restores.
- Cron down / never signs back in: data lingers safely; cron catches up on boot; backdating defended by
  the `NOW()-grace` recheck under lock.
- Lost DELETE response: idempotent via the extended `DeletionMiddleware` scheduled/deleted branch.
- Android Auto Backup resurrecting a retired install id: unchanged — reset then sign-in; within the window
  it cancels+restores.

## Ordered build + test sequence

1. Migration `052_account_pending_delete.sql` (+ index). Verify chain applies via `testutil`.
2. Split `delete_account.go`: `RequestAccountDeletion` (pending + receipt-retire + revoke creds +
   InvalidateAccount) and `purgeOneAccount` (today's destructive body).
3. `account_purge.go` cron mirroring `archive_purge.go`; wire in `main.go` beside `:516`; share the grace
   constant.
4. `AccountDeletionState` + `DeletionMiddleware` scheduled/deleted/401 branch.
5. Capture `created`; add `cancelPendingDeletion` before `ensureSignInInstall` in both sign-in paths; add
   `DeletionCancelled` to result/response.
6. Backend tests (real Postgres): pending→cancel→restore (same-identity + cross-provider email-link);
   pending→purge after backdated window; purge skips inside window + SKIP LOCKED multi-replica;
   second-device 410/401 then re-sign-in cancel+recover; retired-install interaction; idempotent DELETE
   retry (scheduled vs deleted); shared-tally stays open during window, closes only at purge.
7. Mobile: `account-deletion.ts` accept `deletion_scheduled`; `auth.ts` flag + recovery/toast;
   `account.tsx` copy; `i18n.ts` en+fa keys.
8. `npm run selftest:account-deletion` (+ boot-step receipt case): request accepts scheduled;
   wipe+confirm+resume unchanged; cancelled-flag triggers recovery; copy keys present; manual LTR/Dari
   render check.
9. Update `kaata.af/privacy` + store-listing deletion disclosure; re-verify the reviewer account flow.

## Critical files
- `apps/backend/internal/auth/delete_account.go`, `identity.go`, `middleware.go` (+ `service.go`,
  `deletion_receipt.go`, `handler.go`)
- `apps/backend/internal/vaults/archive_purge.go` (purge-cron template → new `account_purge.go` + wiring
  in `cmd/server/main.go`)
- `apps/mobile/lib/auth.ts` (+ `account-deletion.ts`, `app/account.tsx`, `lib/i18n.ts`)
