# Production-readiness — remaining work

Follow-up to the 2026-07-08 pre-launch audit. The `fix/prod-readiness-audit`
branch fixed all 5 store-policy blockers plus B6/B8/B9 and ~50 more findings
(31+ commits, all typecheck/build/test green). This file tracks everything that
was **deliberately not done** so it isn't forgotten.

Full interactive report (all 116 findings): the Claude artifact from that session.
Severity: **blocker** > **high** > **medium** > **low**.

---

## 1. Needs an external action (not code — can't be done in-repo)

| Item | What to do |
|---|---|
| **Apple Developer setup (B3)** | Enable *Sign in with Apple* for bundle `af.kaata.app` in the Apple Developer account, then do an EAS native rebuild. The code (backend `/v1/auth/apple` + mobile button) is committed but inert until this exists. |
| **Export compliance (L6)** | We set `ITSAppUsesNonExemptEncryption=false` in `app.json` to unblock App Store uploads. Confirm this matches your export-compliance determination (the app bundles `@noble/ciphers`/Ed25519, though mesh is parked). If not exempt, remove the key and answer the questionnaire / file the self-classification. |
| **Postgres backups (H10)** — high | The "one year of data" recovery promise has **no DR** behind it. Configure Dokploy's Postgres backups (or `wal-g`/nightly `pg_dump` off-box) and note it in `docs/recovery-runbook.md`. |
| **iOS Google decision (B1)** | Google sign-in is now Android-only; iOS uses Apple. If you want Google on iOS too, create an iOS-type OAuth client in GCP project 987359341353, set its reversed id as the `@react-native-google-signin` plugin `iosUrlScheme`, pass `iosClientId` to `GoogleSignin.configure`, and re-enable the iOS card in `onboarding/auth.tsx`. |
| **Store listing** | Privacy: `kaata.af/privacy`. Terms: `kaata.af/terms`. Both live. Fill the Play Data Safety / Apple nutrition labels from the actual data inventory (see H7 — signed-in sync uploads names/phones/amounts), not the stale "never leaves the device" docs. |

---

## 2. Deferred: native mesh (dead code under `MESH_PARKED=true`)

None of these run in the shipping build. Fix before the mesh-revival release.

| ID | Sev | File | Issue |
|---|---|---|---|
| B7 | blocker | `modules/kaata-bt-classic/.../mesh/MeshDb.kt:32` | Opens the ledger DB with a 2nd SQLite library in-process → corruption vector. Route native ingest through expo-sqlite's build / a staging DB / a hard cross-VM lock. |
| H12 | high | `.../mesh/MeshEngine.kt:153` | `serverWitnessPubkeys = emptyList()` → server-witnessed members refused by the background engine. Read `mesh_server_pubkey_*` from `MeshDb.getAppMeta`. |
| H13 | high | `.../plugin/plugins/BtcRfcommPlugin.kt:243` | `tryDial` never closes the `BluetoothSocket` on `connect()` failure → fd leak in the resident dial loop. |
| H14 | high | `modules/kaata-gatt-server/.../KaataGattServerModule.kt:642` | 5 GATT Binder-thread callbacks call `sendEvent()` unguarded → uncaught-throw process kill. Replicate the sibling module's `safeEmit`. |
| M16 | med | `.../mesh/MeshHandshake.kt:108` | Pre-auth Hello leaks membership proof bundle + IDs + BT MAC in plaintext to any dialer with the vault-derived UUID (incl. removed members). |
| M17 | med | `plugins/withBleAdvertiser.js:102` | `ACCESS_FINE_LOCATION` force-removed → classic BT discovery finds nothing on Android ≤11. Add a `maxSdkVersion=30` capped declaration. |
| M18 | med | `lib/mesh/anti-entropy.ts:2033` | `author_seq` unsigned/from-wire → a member can poison a co-member's version-vector frontier. Sign `author_seq` in the envelope. |
| M19 | med | `lib/mesh/local-pair.ts:342` | One-way pair admission not bound to the joiner; nonce exposed in QR + pre-AEAD Hello. Make the two-way scan the default. |
| L20 | low | `.../mesh/MeshEngine.kt:52` | `stop()` doesn't bound in-flight sessions/dials → windows overlap, stacking dial loops + DB handles. |
| L21 | low | `lib/mesh/device-key.ts:122` | Device Ed25519 key stored with default keychain accessibility → migratable via iOS encrypted backup. Use a `THIS_DEVICE_ONLY` variant. |
| L22 | low | `lib/mesh/discovery-lan.ts:132` | mDNS TXT advertises a stable `install_id` prefix → cross-network device tracking. Use a per-day salted tag. |
| L23 | low | `lib/mesh/anti-entropy.ts:1009` | Membership graph in cleartext in the pre-AEAD Hello over insecure BLE/BTC/LAN. |
| L29 | low | `.../mesh/MeshEventSig.kt:176` | `jsonQuote` diverges from JS `JSON.stringify` for unpaired surrogates → valid JS-signed event tombstoned as `bad_signature` by native ingest. |
| L18 | low | `components/MeshController.tsx:452` | Mount-time else-branch races the app_meta poll → can persist `shop_mode_enabled="0"`. |
| L19 | low | `app/dev/btc-test.tsx:160` | Dev screen leaks the RFCOMM server + subscription on unmount; route registered in prod Stack. |
| L30 | low | `components/MeshController.tsx:350` | Start-retry backoff chain can re-arm `startShopMode` after unmount. |

---

## 3. Needs on-device testing before it's safe to change (risky to do blind)

The async mutex is **non-reentrant**, and these touch auth housekeeping / the
recovery orchestration; a wrong change can deadlock or corrupt. Do with the
`/verify` skill or a device build.

| ID | Sev | File | Issue |
|---|---|---|---|
| B8 (rest) | blocker | `lib/db-tx.ts:183/200`, `lib/restore.ts:339`, `db.ts:3096` (createSelfProfile), `lib/auth.ts` housekeeping, `vault/new`, `pair-scan`, `local-pair`, `trust/revocation` | Wrap each remaining event_log/projection write-transaction in `applyEventMutex.runExclusive` — **but verify each isn't already called under the mutex** (deadlock). Only `decrementPendingUsage` + `fetchPendingInvitations` were done (verified leaves). |
| H15 | high | `lib/sync/pull.ts:250`, `lib/auth.ts:463` | "Keep & Link" account switch: a 403 not_member self-revokes the just-seeded membership → every previously-registered kaata vanishes. Block/warn on Keep when locally-registered vaults exist under the old account, or make the self-revoke distinguish "server never knew this account". |
| H20 | high | `lib/recovery.ts:158` | App-kill mid-recovery mints the self row before the loop → next boot bypasses onboarding into a broken empty home. Add a `recovery_in_progress` app_meta flag; on boot, route back to restore if set. |
| H22 | high | `lib/recovery.ts:115`, `lib/mesh/device-key.ts:186` | `registerDeviceKey` swallows all failures, so recovery's fallback is dead code and the witnessed bind 412s forever. Make it propagate failure; re-register before the pending-witness retry. |
| H23 | high | `lib/auth.ts:463` | Every re-sign-in runs `UPDATE vault_members_mirror SET revoked_at WHERE account_id != mine` → wipes legitimate members from the Members screen with no repair. Scope the revoke to a prior *bound* account, not blanket `!= mine`. |
| M24 | med | `internal/sync/service.go:659`, `internal/sync/membership.go:305` | Member witnesses aren't epoch/revocation-bound; per-process membership cache isn't cross-replica. Bind witnesses to `vault_epoch`; re-verify membership in the push txn for membership events. (Not exploitable on single-replica today.) |
| M37 | med | `app/vault/members.tsx:278` | Owner actions trust screen-mount state (no re-read while focused) → can remove/demote a concurrently-promoted co-owner. Re-query the target's mirror row at action time; subscribe to `useLedgerRefresh`. |

---

## 4. Needs an append-only schema migration

| ID | Sev | File | Issue |
|---|---|---|---|
| M30 | med | `lib/projection/persons.ts:166` + Go `project.go` | `person_archived/unarchived` have no HLC gate on mobile (arrival-order wins) while Go replays in HLC order → archived state diverges. Needs a per-relationship `archived_at` HLC (field-HLC sidecar on `relationships`) on **both** mobile (append migration) and Go, plus a corpus fixture. |

---

## 5. Low-severity tail (safe, just not done yet)

| ID | Sev | File | Issue |
|---|---|---|---|
| M35 | med | `lib/projection/audit-log-local.ts:90` | Local audit log renders quarantined/tombstoned/unapplied events as real history. Add `applied_at IS NOT NULL AND quarantine_reason IS NULL AND tombstone_reason IS NULL`. |
| M36 | med | `lib/projection/audit-log-local.ts:137` | Audit actor is the unauthenticated wire `actor_account_id` (spoofable as owner). Resolve from the signer credential, or reject wire-actor != credential in the role-gate. |
| M38 | med | `lib/projection/vault_members.ts:264` | `applyVaultMemberRoleChanged` on a missing row is a warn-only no-op whose HLC then shadows the late `vault_member_added`. UPSERT the mirror row, or throw `MissingPrereqError`. |
| M6 | med | `internal/crashreport/service.go:88` | Crash rows store client IP (linkable to person). 90-day retention exists; still: drop/hash the IP and scrub digits/emails from messages client-side. |
| M26 | med | `lib/recovery.ts:477` | `refineLocalSelfName` copies an arbitrary vault's `owner_name` onto the recovered self → a joined staff member gets the owner's name. Filter to a vault where `role==='owner'`. |
| M27 | med | `lib/recovery.ts:222` | A no-snapshot + failed-pull vault is still counted "recovered" → success UI shows an empty kaata. Track whether ledger content actually landed. |
| L9 | low | `internal/db/migrations/026_waitlist.sql` | Waitlist stores email+IP+UA indefinitely, no delete/unsubscribe. Drop ip/user_agent; add an admin delete. |
| L10 | low | `internal/httpx/ratelimit.go:50` | In-memory rate limiter is per-replica; multi-replica multiplies every cap. Document single-replica, or move to Redis before scaling out. |
| L16 | low | `components/ProfileSettingsSheet.tsx:193` | Three perpetual DB polls run for the app's lifetime (15s members-count, 10s mesh, 10s AutoSync-when-signed-out). Gate on visibility / `MESH_PARKED\|\|SOLO` / signed-in. |
| L28 | low | `lib/db.ts:3272` | Code still assumes the dropped `UNIQUE(users.phone_e164)`: self can silently take a contact's number (`updateSelfProfile` has no check, stale comment); concurrent remote adds create duplicate phones. Add the self-vs-contact check + a convergence/diagnostic rule. |
| L31 | low | `lib/recovery.ts:244` | Post-loop active/default selection overwrites the current default when it wasn't in the recovered set. Only overwrite when the default no longer resolves to a live local vault. |
| L32 | low | `lib/recovery.ts:533` | `reestablishOwnerIfConfirmed` re-emits a duplicate synthetic owner add on each re-run while the prior is still pending. Broaden the existence probe. |
| L33 | low | Go `project.go:434` | `entry_amended` touching only `occurred_at_ms` counts as a write on mobile but not Go → `updated_at` diverges. Mirror the semantic; add a corpus fixture. |
| L34 | low | Go `snapshot.go:343` | `snapshotMaxHLC` reconstructs `hlc_last` from `updated_at` (l=0) → loses the logical counter on a same-ms burst frontier. Persist the true max HLC. |
| L36 | low | `app/vault/audit-log.tsx:117` | Viewer gate misses device-key-keyed viewers and redirects only after render → a viewer briefly sees the full audit log. Use `resolveAccountIdCandidates`; hold rendering until role resolves. |
| L37 | low | `components/EntryRow.tsx:52` | Announces as a button whose double-tap does nothing; long-press edit/delete has no a11y action. Mirror `PersonRow`'s `accessibilityActions`. |
| L38 | low | `lib/share.ts` / `lib/i18n.ts:1391` | Persian WhatsApp share: `+`/`−` sign detaches from the Latin-digit amount (bidi). Wrap the cluster in a first-strong isolate. |
| L39 | low | `components/UpdateBanner.tsx:145` | Dismiss `×` is a scaling glyph in a fixed 24×24 box with a sub-44dp target. Use an Ionicons close in a 44×44 pressable. |
| L42 | low | `components/SettingsScreen.tsx:197` | NavRow clamps label/hint/trailing to one line → large-font Persian users lose sync/backup status text. Allow 2 lines; drop the fixed `maxWidth:160`. |

---

## Also worth doing (docs / config hygiene, from the audit)

- Update `CLAUDE.md` + `docs/architecture.md`: the "customer ledger never leaves the device" claim is stale — signed-in sync uploads names/phones/amounts (H7). Now also: self-identity check-in is gated on sign-in (B5), currency follows the active vault (H19), recovery is non-destructive on populated vaults (B9).
- `docker-compose.yml` (M7): bind Postgres to `127.0.0.1` and read the password from an env var (it hardcodes `kaata_dev` and publishes `0.0.0.0:5432`).
- `app.json` (H3) — **SUPERSEDED by the 2026-07 mesh un-park (v0.9.0).** H3 stripped the mesh FGS machinery only because mesh was parked. With Nearby sync revived, the connectedDevice FGS runs a demonstrable task (RFCOMM links to nearby member phones), so `FOREGROUND_SERVICE_CONNECTED_DEVICE` + `./plugins/withKaataForegroundService` are back and now **honestly declarable** in the Play FGS section. What we deliberately KEPT OUT for Play safety: `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (Play-restricted). The battery-exemption flow instead opens the non-gated battery-optimization settings list (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`) — see `KaataBtClassicModule.requestIgnoreBatteryOptimizations` + `lib/battery-exemption.ts`. Play submission still needs: the FGS declaration in Play Console (connectedDevice, justified by nearby-device sync), and a Data-safety entry for the Bluetooth (`BLUETOOTH_SCAN/CONNECT/ADVERTISE`) + `CAMERA` (pair-scan) + `NEARBY_WIFI_DEVICES` / `CHANGE_WIFI_MULTICAST_STATE` / `ACCESS_WIFI_STATE` / `WAKE_LOCK` permissions — friction, not blockers. Verify the shipped AAB with `aapt dump permissions` / the Play permission list.
- `app.json` (M1/M4/M8): `usesCleartextTraffic` is dropped by SDK 54 anyway and ships in the store build — remove it or scope to dev via `expo-build-properties`.
- `app.json` (L7): notification small icon is the full-color launcher icon → blank square. Provide a white-on-transparent silhouette.
- `app.json` (L8): `expo-updates` installed but unconfigured — remove it or set a `runtimeVersion` fingerprint policy.
- APK self-update flow (H4): gate the sideload `apk_url` off for store builds (installer-source check).
