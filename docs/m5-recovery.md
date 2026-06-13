# M5 — Recovery + cleanup (the "one year of data" promise)

**Status:** Design for implementation (2026-06-13). Final Sync v2 milestone. Child of
`sync-v2-architecture.md` §4 (recovery) + §M5. **Done-criteria:** factory-reset phone +
Google sign-in recovers EVERY vault; docs updated; dead code deleted.

**Scope:** FULL, no backwards-compat, no users. Mostly MOBILE — the recon (workflow
`wpbe2ltly`) confirmed the backend already exposes everything recovery needs (`GET /v1/vaults`
with each vault's anchor, per-vault `GET /v1/sync/snapshot`, the M2 witness device-bind
`POST /v1/vaults/:id/witness`). The two backend additions are small (snapshot carries the
anchor + the membership chain; drop the legacy backup).

---

## 1. The recovery model (§4) — a recovered device is a NEW REPLICA, not a new owner

Signed-in user, new phone: verify identity (Google) → same `account_id` → `/v1/vaults` lists
memberships → per vault: snapshot+tail restore → the new device gets a FRESH device key and
binds as a NEW DEVICE of the existing member account (server-witnessed `vault_device_added`).
It does **NOT** re-anchor as owner; the anchor stays the original owner key (pinned, not
re-signed). Local-only owner-key-loss is deliberately NOT recoverable (the doc's honest
stance — nudge backup instead; see §5).

This means my **M4 restore fix is wrong and must be reverted**: `restoreFromSnapshot` adopts
THIS device as the anchor on a fresh restore (restore.ts ~330-348). On a genuine recovery
that (a) diverges the anchor from the original chain (peers verify against the original
anchor → handshake fails), and (b) makes `runGenesisBackfill` fire a SECOND genesis
(backfill.ts:133 only fires when `anchor===thisDevice` — which the M4 hack makes true). Both
are corruption. M5 pins the ORIGINAL anchor.

## 2. What a recovered device needs to MESH (not just read)

Server sync works immediately (account-level ACL). To also MESH, the recovered device needs
THREE things in its local `event_log`/state:

1. **The pinned original anchor** — to verify peers. Sourced from the snapshot (§3.1).
2. **The membership chain events** (genesis + the account's `vault_member_added` + the
   original devices' `vault_device_added`) — to build a proof bundle and fold its own
   membership. THESE ARE LOST today: the snapshot is ledger-projection + post-cursor tail and
   carries no membership events (snapshot.go:187-201). Fix in §3.1.
3. **Its own witnessed `vault_device_added`** — binding the fresh device key to the member
   account, so its authored events are accepted (not `unknown_actor`) and it can mesh. This
   is `emitWitnessedSelfAdmission` (backfill.ts:277, ALREADY BUILT) — M5 just wires it into
   the recovery flow (§3.3). (`member_witness` being null is FINE for recovery: the account
   is already a member via the restored chain; only the device bind is needed.)

Also: a factory-reset phone has EMPTY pinned witness keys → it can't verify witnessed events.
The sign-in check-in delivers `mesh_server_pubkeys` → `persistPinnedServerPubkeys`; the
recovery flow must ensure that check-in/pin happens before folding witnessed events.

## 3. The build (mostly mobile)

### 3.1 Backend snapshot additions (small)

- Add `vault_trust_anchor_pubkey` to `SnapshotVault` (snapshot.go:59-67 + the SELECT at
  ~157-163) so restore pins the ORIGINAL anchor directly (removes the cross-endpoint
  dependency + the mesh-exclusion window).
- Add a `membership_events` array to the snapshot: the vault's full membership chain
  (`MEMBERSHIP_EVENT_TYPES`) in HLC order, regardless of cursor, in the same wire shape as the
  tail. The recovering device ingests these so its proof bundle is complete.

### 3.2 Mobile multi-vault recovery driver (the core)

- Build `listVaults()` in `lib/vault-api.ts` → `GET /v1/vaults` (role, anchor, members_count
  per vault). No mobile consumer exists today.
- New `lib/recovery.ts` orchestrator: after sign-in, `listVaults()` → for EACH vault:
  `registerDeviceKey()` (once, idempotent) → `fetchSnapshot({vaultId})` →
  `restoreFromSnapshot(snapshot)` → `emitWitnessedSelfAdmission(vaultId)`. Aggregate
  progress/errors; one vault's failure must not abort the others.
- `restoreFromSnapshot` changes: (a) write the snapshot's `vault_trust_anchor_pubkey`
  (REVERT the M4 adopt-this-device hack); (b) ingest the snapshot's `membership_events` into
  `event_log` (idempotent — INSERT OR IGNORE on event_id); (c) HOIST the
  `active_vault_id`/`default_vault_id` writes OUT of the per-vault function (it currently
  clobbers them per vault, snapshot.go also hard-codes `is_default=1`) — the driver picks one
  active/default after the loop (the original `default_vault_id`).
- Wire `app/onboarding/restore.tsx` + `app/restore.tsx` to the multi-vault driver (replace
  the single-`default_vault_id` probe).

### 3.3 Witnessed device-bind wiring

`emitWitnessedSelfAdmission(vaultId)` per recovered vault, AFTER restore + after the witness
keys are pinned. Ensure `registerDeviceKey` precedes the witness call (IssueWitness 404s
without a `device_keys` row).

## 4. Retire the legacy v0.4 backup (clean delete; no users to strand)

- **Mobile:** delete `lib/backup.ts` (whole file — zero importers). Delete the v0.4 bridge in
  `lib/restore.ts` (`V04Backup`, `fetchV04Backup`, `decodeV04Backup`, `importDecodedEvents`,
  `isEventLogEmptyForVault`, `ensureBridgeVaultId`). Delete the `ready_v04` branch +
  `onRestoreV04` + the v04 probe in `app/onboarding/restore.tsx` + its v04 imports. Audit
  dead `onboardingRestore.*` i18n keys. KEEP `fetchSnapshot`, `restoreFromSnapshot`,
  `RestoreSessionExpiredError`/`RestoreTimeoutError`, the `Snapshot` types.
- **Backend:** delete the whole `internal/backup` package + routes `main.go:244-245` + wiring
  - import. Migration `020_drop_backups.sql`: `DROP TABLE IF EXISTS backups CASCADE;` (CASCADE
    drops the indexes + the 006 FK columns). Do NOT edit 005/006 (append-only).
- Stale comment in `components/AutoSync.tsx:23`.

## 5. Backup nag (scenario 3 → 4)

Local-only multi-member owners are the at-risk group (owner-key loss = no admin recovery).
Signal: `account_id == null` (signed out / local-only) AND active vault `members_count > 1`.
Surface: a dismissible home banner (modeled on `UpdateBanner`, index.tsx) + an inline nag in
the Profile/Settings SYNC section. CTA: "Sign in with Google to back up." Persist a dismissed
flag in `app_meta` (per-vault, e.g. `backup_nag_dismissed:<vaultId>`).

## 6. Ops runbooks (docs/recovery-runbook.md)

- **Lost owner phone, signed-in:** new phone → Google sign-in → automatic multi-vault
  recovery (§3). Fresh device key; binds via witness.
- **Stolen staff phone:** owner emits `vault_member_removed` (works offline, gossips +
  server-pushes); the removed device is refused at mesh handshake + on server ACL.
- **Owner-key loss, local-only:** NOT recoverable for admin control (root of trust gone);
  staff data survives on staff devices; create a successor vault. This is why the nag exists.
- **Solo local-only, no backup:** Android Auto Backup is the only net (the user's chosen risk).

## 7. Tests

- Mobile: keep the selftests green; the recovery orchestrator is mostly I/O (SQLite + network)
  so it's a device smoke test, but the pure pieces (anchor-pin logic, the membership-event
  ingest idempotence, the active/default selection) get unit coverage where feasible.
- Backend: snapshot test asserting it now carries the anchor + the membership chain; the
  backup deletion leaves `go test ./...` green; migration 020 runs clean.
- Device smoke (manual, the done-criterion): factory-reset phone + Google sign-in recovers
  EVERY vault (read), and a recovered device can MESH (its witnessed binding + the pinned
  anchor + the restored membership chain let it handshake a peer).

## 8. Execution order

1. Backend: snapshot carries anchor + membership chain; delete `internal/backup` + routes +
   migration 020. (Delegable — disjoint.)
2. Mobile: `restoreFromSnapshot` (pin original anchor, ingest membership events, hoist
   active/default); `listVaults()`; `lib/recovery.ts` driver; wire the restore screens;
   `emitWitnessedSelfAdmission` wiring.
3. Mobile: delete `lib/backup.ts` + the v0.4 bridge + the v04 UI; i18n audit.
4. Backup nag + `docs/recovery-runbook.md`.
5. Adversarial review + gates (mobile tsc + selftests; backend build/vet/test).
