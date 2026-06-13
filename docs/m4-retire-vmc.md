# M4 — Retire VMCs: the membership chain is the sole trust system

**Status:** Design for implementation (2026-06-13). Child of `sync-v2-architecture.md` §M4 +
§7 + locked decision #4. Implements: "VMCs are retired in favor of the membership chain (M2);
the server becomes witness-ACL, not credential issuer."

**Scope (user, 2026-06-13): FULL — mobile + backend, one pass.** No backwards-compat, no
users (local data wipeable). Every vault becomes chain-anchored; the legacy VMC trust system
(server-issued + local-CA VMCs, the `verifyPeerLegacy` handshake path, the `/credential`
QR-join, the pair-token subsystem, the check-in VMC renewal) is deleted end to end.

**Scope reinterpretation:** the architecture's M4 bullet says "delete `anti-entropy.ts`." That
predates implementation — M2/M3/M3.5 _evolved_ `anti-entropy.ts` INTO the new core (the M2c
chain handshake + the M3.5 author_seq vector delta). So we do NOT delete the file; we delete
the LEGACY paths inside it. "BLE on the new core" is already true structurally (BLE is a pure
byte-pipe; `runAntiEntropy` runs over it transport-agnostically) — the remaining work is
making the trust path chain-only so BLE/LAN both run chain-only. Done-criteria stay: two
phones WiFi-off converge over BLE; BLE→LAN upgrade works; M2/M3 security tests pass over BLE.

Exhaustive per-file keep/delete detail: workflow `wf5v6ited` output (6-agent recon).

---

## 1. Invariant to preserve: every vault is chain-anchored

After M4, `loadVaultTrustAnchor(vaultId)` must NEVER return null for a live vault — the
chain path is the ONLY trust path, so an anchor-less vault would have no verification at all.
Two creation paths to harden + the join paths to make chain-native:

- **`createSelfProfile` (db.ts, first vault)** — currently leaves the anchor NULL if
  `ensureDeviceKey` throws, and relies on `runGenesisBackfill` to emit genesis later. M4:
  make `ensureDeviceKey` failure **fatal** for vault creation, and emit the genesis
  `vault_member_added{owner}` **inline** (matching `vault/new.tsx`).
- **`vault/new.tsx` (additional vaults)** — already correct (anchor + inline genesis). Keep.
- **QR-join (`vault/pair-scan.tsx`, `pair/[token].tsx`)** — DELETE the server-anchored
  (`!isLocalCA`) branches. Every QR carries the owner's anchor pubkey; the joiner pins it,
  presents an EMPTY proof bundle + `pair_nonce` in the mesh handshake, and the OWNER emits
  the joiner's admission (`vault_member_added` + `vault_device_added`) during
  `verifyPeerChain` (that path already exists, anti-entropy.ts:1306+). Delete the joiner's
  self-VMC issuance + self-`member_added` (legacy artifacts). The server learns membership
  when those admission events are pushed (server ACL derives the member set from events).
- `runGenesisBackfill` stays as a self-heal safety net.

## 2. Mobile deletions / relocations

**Relocate first (load-bearing for the chain path):**

- `buildLocalAccountId` (`local-vmc.ts:149`) → `lib/trust/account-id.ts`. Pure helper
  (devicePubkey → `local:<b64url16>`); used by the chain (`trust/backfill.ts`, the chain
  handshake). Zero VMC dependency.
- `isRevoked` + the `revocation_list` read/ingest (`vmc.ts`) → `lib/trust/revocation.ts`.
  Used by the chain handshake's early reject + mid-session reverify. Keep
  `applyServerRevocations` ingestion (the server pushes `vault_member_removed`-derived
  revocations); drop the VMC-specific renewal.

**Delete from `anti-entropy.ts`:** `verifyPeerLegacy` (933-1230); collapse the dispatch
(854-856) to always `verifyPeerChain` + drop the `anchored` boolean; `vmc_blob` on
`HelloMessage` + its population; `localVMCBlob` on `AntiEntropyOptions`; the legacy `./vmc`
imports (`verifyVMCAgainstPinnedPeer`, `cachePeerVMC`, `peekVMCDeviceId`, `decodeDevicePubkey`,
`EXPIRY_SKEW_TOLERANCE_MS`, `ParsedVMC`); `PeerSession.vmc` + the `mode:'chain'|'legacy'`
union (collapse); the legacy `reverifyPeerWindow` branch; `buildPopMessageWithEphemerals` +
`POP_DOMAIN` (v2 PoP — keep `POP_DOMAIN_V3`/`buildPopMessageV3`). KEEP `isRevoked` (relocated).

**Delete the modules:** `vmc.ts` and `local-vmc.ts` in full once their non-relocated exports
have no callers. `getDevicesForAccount`, `LOCAL_ISSUER_TAG` are already dead.

**Dispatch gate (`index.ts`) — replace `getCachedVMC` (826, 946):** the dial/accept gate
("which vault do I mesh for") becomes a cheap **chain-membership** check: the vault is
anchored AND I hold a foldable self-membership (or am the owner). The real membership check
stays in `verifyPeerChain`; this gate only filters candidates. Replace
`reissueSelfVMCsIfMissing` (a self-VMC minter) and the `startShopMode` eligibility
("OR has a cached VMC") with the anchored/membership check.

**Check-in cleanup (`_layout.tsx`, `app-meta-context.tsx`, `api.ts`, `types.ts`):** remove
`vmc_renewals_needed` (request) + `vmc_renewals` (response) + the
`collectRenewalsForCheckIn`/`applyVMCCheckInResponse` VMC arm. KEEP `mesh_server_pubkeys`
(witness-key pinning — rename out of the "VMC" framing) + the revocation cursor
(`last_revocation_seen_at_ms`, re-sourced server-side from membership events).

**`role-gate.ts`:** delete the Step-4 `vault_credentials.vmc_blob` role fallback
(role-gate.ts:267-298) — with full cutover every member has a `vault_member_added`, so the
chain-derived role fully covers it. (Verify no member is silently downgraded to
`unknown_actor` — the chain mirror must cover every case the fallback did.)

## 3. Backend deletions / re-sourcing

**Delete (legacy VMC issuance):**

- `internal/mesh/service.go`: `IssueVMC` (177-292), `IssuedVMC`/`IssuedVMCForVault`,
  `canonicalJSON` (VMC-only — witness uses `internal/canonical`), `VMCLifetime`/
  `VMCWireVersion`/`VMCIssuer`. KEEP `ErrSigningUnavailable`/`ErrDeviceKeyNotRegistered`/
  `ErrNotMember` (witness uses them).
- `internal/mesh/handler.go`: `IssueCredential` (112-202) + its request/response types;
  route `main.go:244-245`.
- **Pair-token subsystem (2nd-order legacy deletion):** `ConsumePairToken`/
  `RegisterPairToken`/`PromotePairTokenMembership`, `Handler.RegisterPairToken` + the
  pair-token branch in `IssueCredential`, route `main.go:257-258`, table `vault_pair_tokens`
  (migration 010), mobile `registerVaultPairToken`/`issueVaultCredential`. The ONLY consumer
  of a consumed pair-token was `IssueCredential`. (QR-join is now chain-native: the pair
  rendezvous is the mesh `pair_nonce`, not a server token.)
- `internal/checkin/service.go`: `VMCRenewalsNeeded` req field + `VMCRenewals` resp field +
  the renewal loop (355-372). KEEP the `MeshServerPubkeys` announcement.

**RE-SOURCE revocation (the load-bearing risk):** `revocation.go` + the check-in
`Revocations` delta are today a SQL view over `vault_credentials_issued`. M4 re-sources them
from **membership events** the server already stores: a device is revoked iff a
`vault_member_removed` (member) or `vault_device_removed` (device) event applies in the
server's own deterministic fold (lawful-at-HLC) — the server runs the SAME fold every device
runs. Concretely: derive the revocation set from the `events` table (membership event types)
rather than `vault_credentials_issued`, then DROP the table (migration). `device_keys`
(same migration 009) STAYS — the witness reads it; do NOT drop migration 009 naively, write a
new migration that drops only `vault_credentials_issued` + `vault_pair_tokens`.

**KEEP:** the M2 witness (`witness.go`), `device_keys`, the revocation delta (re-sourced),
ACL on push/pull (already derives the member set from events).

## 4. High-risk seams (recon) — how each is handled

| Risk                                                            | Handling                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCachedVMC` is the dial/accept gate                          | Replace with the anchored+membership gate (§2).                                                                                                                                                              |
| Dropping `vault_credentials_issued` breaks `revocation.go`      | Re-source revocation from membership events first, THEN drop the table (§3).                                                                                                                                 |
| `/credential` is the only server membership-create for QR joins | Join is chain-native; server learns membership via pushed admission events (§1).                                                                                                                             |
| Dispatch needs `loadVaultTrustAnchor` non-null                  | Every vault anchored (§1); delete anchor-less creation paths.                                                                                                                                                |
| `vault_credentials` read by chain appliers + backfill           | KEEP the mobile `vault_credentials` table for now (chain appliers' device fan-out); only the BACKEND `vault_credentials_issued` is dropped. Revisit migrating the fan-out to `vault_devices` as a follow-up. |
| `role-gate` Step-4 VMC fallback                                 | Delete only after confirming the chain mirror covers every member (§2).                                                                                                                                      |

## 5. Execution order

1. **Relocate** `buildLocalAccountId` → `lib/trust/account-id.ts`; `isRevoked` + revocation
   read/ingest → `lib/trust/revocation.ts`. Repoint chain-path importers. (Unblocks module deletion.)
2. **Every vault anchored:** `createSelfProfile` genesis inline + fatal; delete server-anchored
   join branches; make QR-join chain-native (delete joiner self-VMC/self-member_added).
3. **`anti-entropy.ts` chain-only:** delete `verifyPeerLegacy`, dispatch collapse, `vmc_blob`,
   `localVMCBlob`, v2 PoP, `PeerSession.vmc`/mode, legacy imports.
4. **Dispatch gate + index.ts:** replace `getCachedVMC` gate, `reissueSelfVMCsIfMissing`,
   `startShopMode` eligibility; drop VMC re-exports.
5. **Check-in cleanup** (mobile + the api/types fields) + **`role-gate` Step-4 deletion**.
6. **Delete `vmc.ts` + `local-vmc.ts`** (after all callers gone).
7. **Backend:** delete `IssueVMC` + `IssueCredential` + route + pair-token subsystem +
   check-in VMC fields; re-source revocation from events; migration to drop
   `vault_credentials_issued` + `vault_pair_tokens`.
8. **Review** (adversarial) + **gates:** mobile tsc + all selftests; backend
   build/vet/gofmt/test; device smoke test (two phones, chain-only join + WiFi-off BLE
   convergence + removed-member refusal).

## 6. Tests

- Mobile: existing selftests stay green (chain-selftest, role-gate, vector-sync, …). Add a
  chain-only join assertion if feasible without SQLite.
- Backend: `go test ./...` incl. the m2 witness tests; add/adjust a revocation test to assert
  the event-sourced revocation set equals the old `vault_credentials_issued`-sourced one.
- Device (manual): chain-native QR join (no `/credential`), two phones WiFi-off converge over
  BLE, removed-member is refused at handshake.
