# M2 — The Membership Chain

**Status:** Design for implementation (2026-06-13). Child of `sync-v2-architecture.md` §7.
Replaces the dual VMC credential system with ONE source of trust: signed membership
events inside the vault's own log.

**Outcome:** pair → demote → revoke all work offline-only AND server-mediated; a revoked
device is refused on handshake by any peer holding the removal event; local-only vaults
gain revocation (today a stolen staff phone means abandoning the vault); the
server-anchored and local-CA code paths become one.

---

## 1. Trust anchors

| Anchor             | What it is                                                                                                                          | What it can authorize                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vault anchor**   | The owner's device Ed25519 pubkey, fixed at vault creation (`vaults.vault_trust_anchor_pubkey`, already on both mobile and backend) | Everything: member admission, role change, removal, device binding. Transitively: anything an owner-role member signs (see chain rules).                                                       |
| **Server witness** | The backend's mesh signing key (pubkey already pinned on devices via check-in: `mesh_server_pubkey_primary`)                        | ONLY attestations: "account A controls device D" and "owner-account O invited account A at role R". The server can never admit anyone the owner didn't invite, and never signs ledger content. |

The vault anchor is primary for every vault — including Google-signed ones (Phase 7's
local-CA decision generalized). The witness exists because the online/invite flow admits
people the owner's device has never met.

## 2. Membership events and their signing rules

Existing types (payloads extended where noted), plus two new ones:

| Event                            | Payload                                            | Valid signers                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault_member_added`             | `{account_id, role, display_name?, witness?}`      | (a) an **owner-role member's bound device** — offline/QR path; genesis self-admission is signed by the anchor itself; (b) **any member device + server witness** over `(vault_id, inviter_account_id, account_id, role)` — online invite path (witness proves owner intent via the invite the server brokered). |
| `vault_member_role_changed`      | `{account_id, role}`                               | owner-role bound device.                                                                                                                                                                                                                                                                                        |
| `vault_member_removed`           | `{account_id}`                                     | owner-role bound device. Removes the account AND all its devices.                                                                                                                                                                                                                                               |
| `vault_device_added` **(new)**   | `{account_id, device_id, device_pubkey, witness?}` | (a) owner-role bound device — QR path (owner physically present); (b) **the named device itself + server witness** over `(vault_id, account_id, device_id, device_pubkey, issued_at_ms)` — online path (server verified account control via JWT).                                                               |
| `vault_device_removed` **(new)** | `{device_id}`                                      | owner-role bound device, or the device's own account's other bound device (self-service "remove my old phone").                                                                                                                                                                                                 |

`witness` payload shape: `{sig_b64, server_key_id, issued_at_ms}` — Ed25519 over a
canonical JSON of the attested tuple (same canonicalizer as event signing). Witness
freshness: `issued_at_ms` within ±7 days of the event HLC (limits replay of a leaked
witness, generous enough for offline queuing after an online witness fetch).

These are ordinary ledger events: HLC-stamped, author-signed (`event_sig_b64` /
`signer_device_pubkey`), replicated by every channel, folded by every replica.

## 3. Chain verification (the core security function)

`verifyMembershipState(vaultId, anchorPubkey, serverWitnessPubkeys, events) → MembershipState`

A pure fold over membership events in HLC order. For each event, the verifier checks
**authorization against the state built so far**:

1. **Genesis:** the first `vault_member_added` must be signed by `anchorPubkey` itself
   (owner self-admission, role=owner). It implicitly binds the anchor device:
   `(owner_account, anchor_device)` enters the device registry.
2. **Signature:** `event_sig_b64` valid for `signer_device_pubkey` (existing event-sig).
3. **Authorization:** the signer pubkey must be a **currently-bound device** of an
   account whose **role at this event's HLC** permits the action (per the table above) —
   OR the event carries a valid server witness per its rule. Bound = added by a prior
   valid `vault_device_added`, not removed.
4. **Monotone fold:** apply the event to the state (members: account→role history;
   devices: pubkey→account binding history). Invalid events are SKIPPED (recorded as
   chain conflicts), never fatal — a malicious insert cannot brick the fold.

Deterministic: every replica folding the same events gets byte-identical state. The fold
IS lawful-at-HLC: role checks inside it use role-at-that-HLC, so an owner demoted at T
still validly signed admissions before T.

**Handshake proof:** a joiner doesn't ship the whole log — it ships the **minimal chain**
for its own (account, device): its `vault_member_added`, its `vault_device_added`, and
recursively the admission events of every signer in that path up to the anchor, plus any
`role_changed` events needed to prove signer authority. Bounded and small (depth =
admission delegation depth, typically 1–2). The verifier runs the same fold over
`(proof events ∪ its own local membership events)` — so a removal the verifier knows
about wins regardless of what the presenter omits.

## 4. Where events come from (flow by flow)

| Flow                                          | Emitter                                                                                            | Events                                                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault creation                                | owner device                                                                                       | genesis `vault_member_added` (self, owner) — **already emitted today**; M2 makes it the chain root.                                                                                                                                                  |
| QR pair (offline or online)                   | **owner device**, at the moment the joiner's handshake presents the pair token + its device pubkey | `vault_member_added` (if account unknown) + `vault_device_added` (owner-signed). Replicates to everyone incl. the joiner — the joiner's future proofs. TOFU remains ONLY here: the joiner pins the anchor from the QR payload (already v3 behavior). |
| Email invite accept (online)                  | **invited member's device**, right after acceptance                                                | fetches witness sigs (`POST /v1/vaults/:id/witness`) → emits witnessed `vault_member_added` (self) + witnessed `vault_device_added` (self).                                                                                                          |
| New device of existing member (online)        | the new device                                                                                     | witnessed `vault_device_added` (self).                                                                                                                                                                                                               |
| Role change / member removal / device removal | owner device (UI: vault/members)                                                                   | `vault_member_role_changed` / `vault_member_removed` / `vault_device_removed` — same events on local-CA and server vaults; **this is what gives local-only vaults revocation**.                                                                      |

## 5. Backfill: giving existing vaults a chain

Existing vaults have members with no chain (server-invite members, pre-M2 pairs).
One-shot, owner-side: on first M2 launch, the **owner device** folds its current local
knowledge (`vault_members_mirror` + `vault_credentials`) and emits owner-signed backfill
admissions (`vault_member_added {backfill_synthetic: true}` + `vault_device_added` for
every known device pubkey). Guarded by an app_meta flag per vault; idempotent appliers
(duplicate admissions are no-ops in the fold). Non-owner devices simply receive the
chain via normal sync. Until the chain arrives, verification falls back to legacy
sources (§7) — no flag-day.

## 6. Role-gate rewiring

`checkRoleForEvent` resolves (actor account, role at HLC) today from `vault_credentials`
(remote) / wire trust (local). M2 replaces the SOURCE with the membership fold:

- `roleAtHlc(vault, account, hlc)` and `deviceBindingAtHlc(vault, pubkey, hlc)` read the
  folded chain (materialized into `vault_membership_state` + `vault_device_registry`
  tables, updated by the membership appliers; the event log remains the history for
  at-HLC queries — indexed `(vault_id, event_type, hlc)`).
- **Transition rule:** if the chain has no genesis for the vault yet (pre-backfill), fall
  back to the legacy lookup exactly as today. Chain presence is per-vault, detected once
  and cached.
- The LRU cache and lawful-at-HLC semantics stay identical.

## 7. Handshake integration (existing BLE/mesh transport)

- Mesh `Hello` bumps its protocol version (clean break — mixed-version peers refuse
  with an "update kaata" message; mesh has no real-world deployment to preserve).
- `Hello` carries the proof bundle instead of a VMC. Verification:
  `verifyMembershipState` over proof ∪ local events; then the existing
  proof-of-possession nonce signature, unchanged.
- Refusal rules: unknown/invalid chain → refuse; **locally-known removal of the
  presented account/device → refuse** (the M2 done-criterion); vault_epoch checks retire
  with VMCs.
- VMC code paths (`vmc.ts`, `local-vmc.ts`, server issuance, check-in renewals,
  revocation cursors) stay compiled-but-unreached behind the version gate, deleted in M4
  with the transport rewrite.

## 8. Server-side (witness + fold + ACL)

1. **Witness endpoint** `POST /v1/vaults/:vault_id/witness` (JWT): for the calling
   account+install, returns `{member_witness?, device_witness, server_key_id}` —
   signatures over the §2 tuples. Member witness only when a brokered invite exists
   (server checks its invite tables — owner intent). Mesh signing key already exists.
2. **Push-side verification:** membership events are signature-verified against the
   vault anchor / witness rules at push (server already stores sig fields M1-style? if
   not, they ride the existing envelope), then folded into `vault_members` (existing
   table — stays the server's operational ACL) + new `vault_devices`.
3. **Existing membership endpoints** (SetMemberRole / RevokeMember / AcceptInvite) keep
   working for old clients but ALSO no longer fight the chain: new clients drive
   membership through events; the server folds both sources with events winning (HLC).
4. `vault_credentials_issued` + `/credential`: legacy, untouched, retired in M4.

## 9. Security invariants (test these, not vibes)

1. A device with no chain (or a forged sig anywhere in its proof) is refused — over
   handshake AND at role-gate apply.
2. A non-owner cannot admit, promote, demote, or remove anyone (fold skips + records).
3. A removed member's device is refused on handshake by any peer holding the removal;
   its pre-removal events still apply (lawful-at-HLC); post-removal events quarantine.
4. A leaked server witness key alone cannot join a vault (witness without account JWT
   path → server never issues; witness ≠ admission for the offline path) — and CAN be
   rotated (witness verification accepts the pinned key set, plural).
5. Owner key loss without backup: staff data survives (their replicas are full); admin
   control requires successor vault — documented runbook, unchanged from architecture
   doc §4.
6. Two owners demoting each other concurrently converge identically on every replica
   (deterministic fold, HLC order, skip-invalid).

## 10. Implementation order

- **M2a** `lib/trust/` chain module (pure fold + proof builder + verifier, bun
  selftests with real Ed25519) · new event types + appliers + migration 019 (state
  tables + indexes) · emission wiring (QR join, invite accept, members UI, genesis
  backfill).
- **M2b** role-gate source swap with legacy fallback · server witness endpoint + push
  verification + fold (Go tests).
- **M2c** handshake swap + version bump + removal refusal.
- **M2d** adversarial review workflow (security-weighted) + invariant test pass.
