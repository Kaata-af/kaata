# Kaata Sync v2 — Networking, Identity & Replication Architecture

**Status:** Proposed (2026-06-12). Supersedes the networking/transport/auth sections of
`sync-implementation-plan.md` (D5, D6, and the "Google auth only" + "mesh may never ship"
decisions). The event-sourcing core (D1), vault model (D2), and access-control semantics
(D4) of that plan are retained — they are built, shipped, and sound.

**One-sentence summary:** One replication protocol over many transports; the server is
just the replica that never sleeps; identity is an account UUID that survives any auth
provider; trust is a single signed membership chain anchored on the vault owner's device
key.

---

## 1. Requirements — the five usage scenarios

| #   | Scenario                                              | What it requires                                                                                                                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Solo shopkeeper, no internet, 1–2 personal vaults     | Pure local SQLite (works today). Nothing leaves the device.                                                                                                  |
| 2   | Solo + internet, wants backup                         | Vault replicated to the server. Phone lost → verify identity → full restore.                                                                                 |
| 3   | Multi-staff shop, **no internet**                     | Devices sync over local radio (LAN WiFi or BLE), membership + roles enforced offline, rival shops can neither read nor join.                                 |
| 4   | Multi-staff + internet (even if only the boss has it) | Mesh locally; any online member relays the **whole vault** to the server. Everyone's edits end up backed up even if their own phone never sees the internet. |
| 5   | Multiple shops/owners, one shared vault               | Same as #4 at larger scale; members in different buildings converge via the server; members in the same building converge via mesh.                          |

Non-negotiable cross-cutting requirements:

- **R1 — No data loss on auth migration.** Google today, phone-OTP tomorrow. A user with
  a year of data and a lost phone must be recoverable by identity verification alone.
- **R2 — No single point of failure.** Internet, LAN, BLE are alternative channels for the
  _same_ sync; losing any one degrades latency, never correctness.
- **R3 — Confidentiality from outsiders.** A rival shop on the same WiFi/BLE radio space
  can neither read vault traffic nor join the vault. (Server-readable-at-rest remains the
  deliberate trust contract from the original plan — see §8.)
- **R4 — Offline writes are never punished.** Edits lawful when made are accepted later
  (lawful-at-HLC, already implemented in the role-gate and the server push path).

---

## 2. What we keep, what we delete (verbatim from the code audit)

### Keep (battle-tested, survives the rewrite untouched or lightly extended)

| Component                           | Where                                           | Why                                                                             |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Event envelope + HLC                | `lib/events.ts`, `lib/hlc.ts`                   | Deterministic total order, 60s drift clamp, proven.                             |
| Ed25519 event signing               | `lib/event-sig.ts`, `lib/mesh/device-key.ts`    | Canonical-JSON signatures with embedded signer pubkey.                          |
| Ingest/apply split + quarantine     | migration 014, `lib/ingest-types.ts`            | Receipt ≠ acceptance; fixed the real data-loss bug.                             |
| Role-gate (lawful-at-HLC)           | `lib/projection/role-gate.ts`                   | Per-event ACL at the event's own timestamp.                                     |
| Projection appliers                 | `lib/projection/*`                              | Deterministic fold; shared corpus with Go.                                      |
| Server event store                  | backend `events` table, per-vault `server_seq`  | Already an append-only per-vault log with idempotent push + cursor pull.        |
| Snapshot bootstrap                  | backend `vault_snapshots` + `/v1/sync/snapshot` | New-device fast path.                                                           |
| Vault membership tables + audit log | backend `vault_members`, `vault_audit_log`      | Sound ACL data model.                                                           |
| BLE GATT native module              | `modules/kaata-gatt-server`                     | Hard-won Android peripheral code (MTU races, FGS, MIUI quirks all fixed).       |
| Session AEAD                        | `lib/mesh/aead.ts`                              | X25519 + HKDF + ChaCha20-Poly1305 framing — reused as the LAN handshake cipher. |

### Delete / replace (the duct tape)

| Component                                                     | Where                                                                              | Replaced by                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebRTC transport + HTTP signaling server                      | `lib/mesh/transport.ts`, `signaling-server.ts` (~1,360 LOC)                        | Plain TCP + Noise-style handshake on LAN (§6.2). WebRTC bought us DTLS at the cost of a local HTTP signaling server, ICE timeout towers, and the heaviest native dependency in the app — for peers that are _on the same LAN and can just open a socket_. |
| HLC-frontier anti-entropy                                     | `lib/mesh/anti-entropy.ts` (~1,700 LOC)                                            | Per-device sequence vectors (§5). The current design has no per-author counter, so every sync recompares full HLC frontiers and cannot resume mid-batch.                                                                                                  |
| Dual trust systems (server VMC + local-CA VMC + TOFU pinning) | `lib/mesh/vmc.ts`, `local-vmc.ts`, server `vault_credentials_issued` issuance path | One signed membership chain inside the event log itself (§7). VMCs become derived artifacts, not a parallel source of truth.                                                                                                                              |
| Legacy per-install backup                                     | backend `/v1/backup/*`, `backups` table, `lib/backup.ts`                           | Vault replication to the server IS the backup (already the stated plan; v2 actually does it).                                                                                                                                                             |
| `wifi-upgrade` WebRTC escalation                              | `lib/mesh/wifi-upgrade.ts`                                                         | Same concept (BLE detects big delta → prompt → faster channel), retargeted at LAN-TCP.                                                                                                                                                                    |

---

## 3. The core idea: one log, one protocol, many transports

Every vault is an append-only log of signed events. Every device that is a member holds a
full replica. **The server is simply one more replica — the one with a public address and
no battery.** Backup, online sync, offline mesh, and store-and-forward relay are then the
same operation: _converge two replicas of the same log_.

```
            scenario 3 (no internet)             scenarios 2/4/5 (some internet)

   ┌────────┐   LAN/BLE   ┌────────┐          ┌────────┐      HTTPS      ┌────────┐
   │ boss   │◄───────────►│ staff1 │          │ boss   │◄───────────────►│ SERVER │
   └───┬────┘             └────────┘          └───┬────┘                 │ replica│
       │  LAN/BLE                                 │ LAN/BLE              └───▲────┘
   ┌───▼────┐                                 ┌───▼────┐    (staff never     │
   │ staff2 │                                 │ staff2 │     online — boss   │
   └────────┘                                 └────────┘     relays for all) │
                                                                       other shop's
                                                                       members (sc. 5)
```

This collapses what is currently three separate codepaths (`lib/sync` push/pull,
`lib/mesh` anti-entropy, `lib/backup` snapshots) into **one replication module with three
transport drivers**. Scenario 4 falls out for free: events authored by an offline staff
phone reach the boss's phone over mesh, and the boss's phone pushes _all_ events it holds
(not just its own) to the server. The server's lawful-at-HLC check already accepts relayed
events from any current member.

---

## 4. Identity: accounts that outlive auth providers (R1)

### What's already right

`accounts.id` is a neutral UUID; the session JWT's subject is `account_id`, not the Google
sub; events carry `actor_account_id`. Nothing in the ledger data is keyed on Google.

### What changes (backend, small but load-bearing)

1. **`account_identities` table** — move provider bindings out of `accounts`:

   ```sql
   CREATE TABLE account_identities (
     account_id   UUID NOT NULL REFERENCES accounts(id),
     provider     TEXT NOT NULL,          -- 'google' | 'phone_otp' | future
     provider_sub TEXT NOT NULL,          -- google sub | E.164 phone
     verified_at  TIMESTAMPTZ NOT NULL,
     PRIMARY KEY (provider, provider_sub)
   );
   -- Backfill: INSERT SELECT id, 'google', google_sub FROM accounts;
   -- accounts.google_sub kept as a deprecated read-only column for one release, then dropped.
   ```

2. **Auth becomes pluggable.** `/v1/auth/google` and the future `/v1/auth/otp/request` +
   `/v1/auth/otp/verify` both end in the same place: _resolve-or-create account via
   `account_identities`, mint the same session JWT_. The JWT drops `google_sub` from its
   claims (keeps `provider` for audit). Existing 30-day JWTs stay valid — their subject is
   already the account UUID.

3. **Identity linking.** A signed-in user can add a second identity (verify phone while
   Google-signed-in). When OTP launches, existing users link their phone _before_ Google is
   retired; new users start with phone. An account with both can sign in with either.
   Collision rule: verifying an identity already bound to a different account triggers an
   explicit merge flow (rare; manual support path at first — log it, don't auto-merge).

### Recovery after a lost phone (the "one year of data" promise)

- **Signed-in user (scenarios 2/4/5):** new phone → verify identity (Google now, OTP
  later) → same `account_id` → `/v1/vaults` lists memberships → snapshot + tail restore
  per vault. Already ~80% built (`onboarding/restore`); v2 makes it multi-vault and
  provider-agnostic. The new device gets a fresh device key; it's a new replica, full stop.
- **Local-only user with staff (scenario 3):** any surviving member device holds the full
  log. Owner's new phone re-pairs via QR from a staff phone and replicates everything back.
  One rule makes this work: **ownership recovery event** — if the owner key is lost, a
  quorum path is needed. v2 keeps it simple and honest: the owner is told (at vault
  creation, in the backup nag) that a local-only vault's owner key is the root of trust;
  losing every owner device without internet backup means staff data survives but admin
  control requires creating a successor vault. The real mitigation we ship: **aggressively
  nudge local-only multi-member vault owners toward backup** (scenario 3 → 4 upgrade).
- **Local-only solo user, no backup (scenario 1):** Android Auto Backup remains the only
  net. This is the risk they chose; the UI keeps offering backup.

---

## 5. Replication protocol: per-device sequences + vector sync

### The one schema change that fixes sync

Every event gets an **author sequence number**: `(author_device_id, author_seq)` where
`author_seq` is a per-device monotonic counter assigned at append time on the authoring
device. (Mobile migration: add column, backfill existing rows per device in HLC order.
HLC stays — it remains the _merge_ order for projections; `author_seq` is the _transfer_
bookkeeping.)

A replica's state of knowledge is then a **version vector**:
`{ device_id → highest contiguous author_seq held }` — a few dozen bytes for any realistic
vault.

### The sync conversation (any transport, both directions, symmetric)

```
A → B : HELLO   { vault_id, membership proof (§7), transcript-bound key exchange }
A → B : VECTOR  { device_id → max_contiguous_seq }            (and B → A)
B → A : EVENTS  for each author where B holds seq > A's vector:
                events in author_seq order, batches of 500     (and A → B)
A → B : ACK     { author → new contiguous frontier }           (per batch)
```

- **Resumable:** a dropped connection costs nothing — the vector picks up exactly where
  the contiguous frontier stands. (Today a crash mid-delta refetches from the HLC frontier.)
- **Cheap:** summary is O(devices), transfer is O(missing events). No hash sets, no full
  scans per connect.
- **Gap-safe:** per-author in-order delivery means the receiver's frontier only advances
  contiguously; a gap (relay died mid-stream) is visible and re-requested, never silently
  skipped. This kills the relay-hole class of bug that migration 014 and the "vault-hash-set
  breaker" commits were fighting.
- **Ingest unchanged:** every received event still goes through signature verify →
  ingest → quarantine/apply sweep. The protocol only changes _which_ events move, not how
  they're trusted.

The server keeps its per-vault `server_seq` cursor for HTTPS pull (it's a fine transport-
specific optimization for the hub topology), but `/v1/sync/push` accepts relayed events
from any member (it already does) and the server additionally maintains the same version
vector per vault so a relay can ask "what are you missing?" in one round trip
(`GET /v1/sync/vector?vault_id=`— new, trivial endpoint).

Wire format stays JSON (+gzip on HTTP, +AEAD framing on radio). At ledger scale (a busy
shop ≈ 100 events/day) format micro-optimization is noise; debuggability wins. CBOR is a
contained later swap if ever needed.

---

## 6. Transport stack (the actual rewrite)

One interface, three drivers shipping, one deferred:

```ts
interface Transport {
  discover(vaultIds: VaultDigest[]): AsyncIterable<PeerCandidate>;
  connect(peer: PeerCandidate): Promise<SecureStream>; // authenticated, encrypted, framed
}
// Replication module consumes SecureStream; it does not know radio from socket.
```

### 6.1 Internet — the server replica (exists, keep)

HTTPS push/pull/snapshot, 30s foreground poll (existing). Upgrade path to SSE stays parked
exactly as the old plan decided. This driver is also the **relay**: every sync cycle pushes
_all_ un-acked events the device holds for that vault, regardless of author (scenario 4).

### 6.2 LAN — mDNS + TCP + Noise (new; the workhorse for shops with a WiFi router)

Kabul market reality: a shop's router with no upstream internet is still a fast LAN. This
is the highest-throughput offline channel and the simplest code:

- **Discovery:** `react-native-zeroconf` (Android NSD) publishing `_kaata._tcp.local` with
  a TXT record of **salted daily vault digests** (`HMAC(day_key, vault_id)[0:8]` — fixes
  the current unsalted-hash linkability) so only members can correlate.
- **Stream:** `react-native-tcp-socket`, one listening port per device.
- **Security:** Noise-XX-pattern handshake using the **existing** X25519 + HKDF +
  ChaCha20-Poly1305 code from `aead.ts`, with both sides' static keys = their device keys,
  membership proof (§7) bound into the transcript. Result: mutual auth + forward secrecy +
  an outsider on the same WiFi sees only ciphertext (R3). No DTLS, no ICE, no signaling
  server — both peers already see each other's IP from mDNS.

### 6.3 BLE — presence, small syncs, bootstrap (rewrite the thin layer, keep the native core)

For the building-wide bazaar with no shared LAN. Keep: GATT server module, advertiser
patches, AEAD chunk framing, duty-cycled scanning, circuit breakers — that code embeds a
year of Android pain. Replace: the bespoke anti-entropy driver with the §5 protocol over
the same framing; encrypt the handshake phase (current code talks plaintext until the
session key lands — v2 runs the same Noise handshake as LAN over the handshake
characteristic). BLE remains the _slow_ channel: when the vector exchange reveals a delta
too big for comfort (existing estimator), prompt to upgrade: same LAN if available, else
**local hotspot** (deferred driver, §6.4). This is exactly Briar's architecture — BLE for
presence and trickle, WiFi for bulk — which is the validated model for this class of app.

### 6.4 Wi-Fi Direct / hotspot (deferred driver)

For big syncs with no router at all. Explicitly out of v2 scope; the Transport interface
is its insertion point. (The BLE → "turn on hotspot" prompt is a UX problem as much as a
networking one; do it when real bazaar usage demands it.)

### Channel orchestration

- All drivers run under the existing Shop Mode FGS umbrella; server driver also runs
  outside Shop Mode (plain online sync/backup needs no toggle).
- Preference order per peer: LAN > BLE. Server always-on in parallel.
- Dedup by device_id post-handshake (existing pattern); one replication session per peer
  at a time; vector exchange makes redundant channels cheap (they converge to no-ops).

---

## 7. Trust: one membership chain instead of two credential systems

### Design

- **The vault's root of trust is the owner's device public key** — already true for
  Phase-7 local-CA vaults; v2 makes it true for _all_ vaults. The server stops being a
  credential issuer and becomes a witness.
- **Membership is data in the log.** `vault_member_added { account_id, device_pubkey[],
role }`, `vault_member_role_changed`, `vault_member_removed`, `vault_device_added` —
  all signed by an owner (or per role rules), all replicated like any event. Every replica
  derives the member/device set by folding the log (the `vault_members_mirror` +
  role-gate machinery already does precisely this fold).
- **The handshake credential is the chain itself.** A joiner proves membership by
  presenting the owner-signed `vault_member_added`/`vault_device_added` events naming its
  device key; the verifier checks signatures against the trust anchor it already holds.
  No bearer VMC to expire, refresh on check-in, or fall out of sync — if you can show the
  signed admission and sign the handshake nonce with the named key, you're in.
- **Revocation = `vault_member_removed` event.** It gossips over every channel and the
  server pushes it at check-in (existing revocation-cursor plumbing becomes a thin view
  over membership events). An honest peer that has seen the removal refuses the revoked
  device _and stops sending it new events_; lawful-at-HLC preserves the member's
  pre-removal writes (R4). Offline revocation latency is physics, not a bug — bounded by
  first contact with any updated peer or the server.
- **TOFU shrinks to its one legitimate role:** the very first QR pairing, where the QR
  payload pins the owner key (already implemented in pair-qr v3). After that, everything
  is signature-verified against the anchor.

### Why this is strictly better than today

One source of truth instead of three (server `vault_credentials_issued`, local VMC cache,
TOFU pin store); local-CA vaults gain revocation (the current #1 trust gap — today a
stolen staff phone means abandoning the vault); membership changes made offline propagate
exactly like ledger entries; and the handshake code paths for server-anchored and
local-only vaults become identical.

### Server's remaining trust roles

- ACL enforcement on push/pull (derives the same member set from membership events).
- Witness/notary: stamps `server_seq`, providing an arbiter ordering for membership-event
  races (two owners demoting each other offline → deterministic resolution rule:
  lawful-at-HLC fold with HLC order; the server's fold and every device's fold agree
  because it's the same deterministic function).
- Identity verification for recovery (§4).

---

## 8. Security posture summary

| Surface                                   | Protection                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radio (LAN/BLE) eavesdropper — rival shop | Noise handshake, ChaCha20-Poly1305, forward secrecy. Sees ciphertext + salted daily digests only.                                                                                                                                                                      |
| Radio impostor — rival tries to join      | Handshake requires owner-signed admission events + possession of the named device key.                                                                                                                                                                                 |
| Event forgery / tamper in relay           | Per-event Ed25519 signatures verified at ingest (existing). Relays can't alter or inject.                                                                                                                                                                              |
| Demoted/removed insider                   | Membership events gossip + server push; lawful-at-HLC accepts only pre-removal writes.                                                                                                                                                                                 |
| Stolen staff phone                        | Owner issues `vault_member_removed`; works for local-only vaults too (new in v2).                                                                                                                                                                                      |
| Server at rest                            | **Plaintext, deliberately** — unchanged trust contract from the original plan (AI-training play + simple recovery). Revisit-flag: if/when E2EE is wanted, the seam is "encrypt event payloads with a vault key wrapped per-device"; the protocol above doesn't change. |
| Auth takeover                             | Google 2FA today; OTP later inherits SIM risk — mitigate with the identity-linking merge flow + support-channel recovery, documented at OTP design time.                                                                                                               |

---

## 9. Implementation phases

Each phase is shippable, testable with 2–3 phones + the server, and leaves the app
working. Old and new sync never run simultaneously for the same channel.

### M1 — Identity hardening + replication core (backend + mobile lib, no UI)

- Backend: `account_identities` table + backfill; auth service refactor to
  resolve-via-identities; JWT claims cleanup. `/v1/sync/vector` endpoint.
- Mobile: `author_seq` column + backfill migration; new `lib/replication/` module
  (vector exchange + batch/ack engine) with the server driver as its first consumer —
  replacing `lib/sync/{push,pull}` internals behind the same `syncOnce()` surface.
- Done when: two signed-in devices converge through the server using vectors; backup
  restore works on a fresh install; all existing screens untouched.

### M2 — Membership chain (kill the dual trust system)

- New membership event types + appliers (fold targets the existing
  `vault_members_mirror`); QR pairing emits `vault_device_added`; handshake proof =
  signed chain; server derives ACL from the same events; `vault_credentials_issued`
  becomes read-only legacy (dropped one release later).
- Done when: pair → demote → revoke all work offline-only between two phones AND
  server-mediated; a revoked device is refused on handshake by a peer that has the
  removal event; stolen-phone runbook works for a local-only vault.

### M3 — LAN transport

- zeroconf + TCP + Noise driver; delete WebRTC transport + signaling server +
  react-native-webrtc dependency; wifi-upgrade prompt retargeted (BLE → LAN).
- Done when: two phones on an offline router converge a 1,000-event delta < 10s;
  Wireshark shows ciphertext only; third non-member phone on the LAN can't handshake.

### M4 — BLE on the new core

- Replace anti-entropy driver with replication core over existing GATT framing; Noise
  handshake on the handshake characteristic; delete `anti-entropy.ts`.
- Done when: two phones, WiFi off, converge over BLE; BLE→LAN upgrade prompt works;
  the M2/M3 security tests pass over BLE.

### M5 — Recovery + cleanup

- Multi-vault provider-agnostic restore flow; retire `/v1/backup/*` + `backups` table +
  `lib/backup.ts`; backup nag for local-only multi-member vault owners; ops runbooks
  (lost phone, stolen staff phone, owner-key loss).
- Done when: factory-reset phone + Google sign-in recovers every vault; docs updated;
  dead code deleted.

(OTP itself is a later, separate project — M1 is what guarantees it plugs in losslessly.)

---

## 10. Decisions locked by this document (flag now if you disagree)

1. **Server stays plaintext-at-rest** (existing trust contract). E2EE is a defined seam,
   not a v2 deliverable.
2. **No CRDT library** (re-affirmed): the event log + per-field LWW projection is our
   CRDT; Automerge/Loro would add a WASM runtime to replace ~500 LOC we already trust.
3. **WebRTC is removed**, not fixed. LAN = TCP + Noise; we own the handshake we already
   wrote for BLE.
4. **VMCs are retired** in favor of the membership chain (M2). The server becomes witness
   - ACL, not credential issuer.
5. **BLE stays presence/trickle/bootstrap**, never the bulk channel; bulk = LAN now,
   hotspot later. (Briar's proven shape.)
6. **HLC remains the merge order; author_seq is transfer bookkeeping.** Both live on
   every event forever.
7. **Wire stays JSON** until measured pain says otherwise.
