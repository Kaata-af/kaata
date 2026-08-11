# Kaata — Sync, Vaults, and Local-First Implementation Plan

**Status:** Synthesis of nine domain designs (D1–D9). This is the canonical plan; individual D-docs remain useful for justification depth, but where this document contradicts them, this document wins.

**Author of synthesis:** Compiled from D1 (event sourcing), D2 (vaults), D3 (Google auth), D4 (access control), D5 (sync protocol), D6 (mesh transport), D7 (CRDT choice), D8 (migration), D9 (phasing).

**Target reader:** The solo founder building Kaata, plus any future contributor onboarding into the codebase.

---

## Versioning Plan

Kaata stays in the **0.x.x** range until it ships on the Play Store and App Store as a stable, tested release. Phase ships during this plan are pre-store work:

| Version                | Marker                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.4.0**             | Current production APK                                                                                                                                                            |
| **v0.5.0**             | Phase 1 ships — event source foundation                                                                                                                                           |
| **v0.6.0**             | Phase 2 ships — vaults + Google auth + access control                                                                                                                             |
| **v0.7.0**             | Phase 3 ships — sync + backup. **This is the "v1 architecture" milestone in product terms** (the churn-hypothesis-satisfied ship), but stays in 0.x.x in marketing terms.         |
| **v0.8.0**             | Phase 4 ships — multi-user vaults                                                                                                                                                 |
| **v0.9.0** (candidate) | Mesh, if/when validated and shipped (previously framed as "post-Phase-4 hypothesis (v0.9.0 candidate)")                                                                           |
| **v1.0.0**             | **Reserved for the Play Store + App Store launch.** Only stamped after the app has been verified stable through real-world usage at v0.8.x or v0.9.x and accepted by both stores. |

Anywhere this plan still says "v1.0" outside this section, read it as "v0.7.0 (the post-Phase-3 ship)." Anywhere it says "v2.0," read it as "v0.9.0 candidate." Column names that originally read `*_to_v1_*` have been renamed to `*_to_event_log_*` for the same reason.

---

## Executive Summary

Kaata today (v0.4.0) is a local-first SQLite ledger for Afghan shopkeepers. Every customer/supplier debt is stored on the phone. The only network call is `/v1/check-in` on launch. There are no real users yet — the production install base is Matee + a handful of friend-installs, and active marketing is paused for the duration of this build. The architectural bet (backup, multi-vault, mesh) is forward-looking and addresses three objections gathered from earlier shopkeeper conversations: data trust, intermittent connectivity, and shops with multiple staff sharing one ledger.

This plan ships those features without breaking the local-first trust story, in five phases over ~9–12 calendar months at ~20–25 dev hours/week. The architectural sequence is non-negotiable:

1. **Phase 1 — Event Source Foundation.** Refactor `entries` into an append-only event log with Hybrid Logical Clocks. No new feature; just the foundation that makes Phases 3–5 possible without a rewrite later.
2. **Phase 2 — Vaults + Google Auth + Access Control.** Introduce the _shop_ (internal name: `vault`) as the unit of data ownership, add Google sign-in as a real first-class identity, wire access control even though only one user owns each vault for now.
3. **Phase 3 — Server Backup + Single-User Multi-Device Sync.** Signed-in users get cloud backup and the same vault on multiple devices belonging to the same account.
4. **Phase 4 — Multi-User Vault Sync.** Vault owners invite other Google accounts as editors/viewers.
5. **Phase 5 — Local Mesh.** WebRTC over mDNS / BLE for offline peer sync.

**Total to ship-and-stop point (end of Phase 3): ~7–9 calendar months at realistic solo-founder pace, all engineering.** See §"Realistic Calendar" in Cross-Cutting Concerns for the honest breakdown. The earlier headline of "14–18 calendar weeks" was a dev-week count, not calendar time. This is the **v0.7.0** milestone — "churn hypothesis satisfied" in product terms; still 0.x.x in marketing terms because store launch (v1.0.0) is gated on real-world stability proof, not on architecture being shipped. Phases 4–5 are gated on user demand confirmed by real users post-Phase-3 ship, and **Phase 5 is reclassified as a post-Phase-4 hypothesis (v0.9.0 candidate)** — see §Decisions.

**Key tradeoffs the founder has accepted:**

- **No encryption at rest or in transit beyond TLS.** Server reads plaintext ledger data. This is deliberate — the long-term play is aggregating data for AI training. Users who decline Google sign-in continue using the app fully offline forever; their data never leaves the device.
- **Google auth only.** Phone OTP would match the existing "phone is canonical identity" model better, but Afghan SMS infrastructure is unreliable. Google is the pragmatic interim. The bridge is documented in §Decisions.
- **Custom CRDT, no library.** Automerge/Yjs/Loro are over-engineered for ~5 mutable fields and a fundamentally append-only event stream. ~500 LOC of TypeScript replaces a 200KB–600KB WASM dependency on Hermes.
- **Polling not SSE for sync.** 5-second polling foreground, 30-second background. SSE is the upgrade path when polling becomes the bottleneck (not before).
- **Single Postgres for all services.** No Redis, no Kafka. Sync, auth, backup all share `kaata-db`.
- **mDNS-first mesh.** Most target shops have WiFi. BLE + WiFi-Direct is the fallback. Mesh is the last phase and may never ship.

**No external validation gates during the build. Matee self-validates via use; rigorous validation resumes when there are real users (post-Phase-3 ship).**

---

## Architecture Overview

### Event log model

```
                  ┌─────────────────────────────────────────────┐
                  │             SQLite (mobile)                 │
                  │                                             │
                  │   ┌──────────────────────────────────────┐  │
                  │   │            event_log                 │  │
                  │   │  (append-only, source of truth)      │  │
                  │   │                                      │  │
                  │   │  event_id (UUIDv7)  PK               │  │
                  │   │  vault_id                            │  │
                  │   │  entry_id / target_id                │  │
                  │   │  event_type                          │  │
                  │   │  hlc_physical_ms, hlc_logical,       │  │
                  │   │    hlc_device_id                     │  │
                  │   │  supersedes_event_id (chain link)    │  │
                  │   │  payload_json                        │  │
                  │   │  synced_at, origin                   │  │
                  │   └──────────────────────────────────────┘  │
                  │                  │                          │
                  │                  │ projection / fold        │
                  │                  ▼                          │
                  │   ┌──────────────────────────────────────┐  │
                  │   │   entries (materialized projection)  │  │
                  │   │   relationships, users, shop_profile │  │
                  │   │   vault_members_mirror               │  │
                  │   │   (rebuildable from event_log)       │  │
                  │   └──────────────────────────────────────┘  │
                  └─────────────────────────────────────────────┘
```

The event log is _what happened_; the projection is _what is true right now_. The projection is rebuildable from the event log in <2s for realistic ledger sizes.

### Vault + membership model

```
   accounts (server)                  vaults                vault_members
   ┌────────────────┐              ┌──────────────┐      ┌────────────────────┐
   │ account_id  PK │ 1          1 │ vault_id  PK │ 1  N │ vault_id           │
   │ google_sub UQ  │ ─────owner── │ owner_acct   │ ──── │ account_id         │
   │ email          │              │ name         │      │ role               │
   │ name           │              │ created_at   │      │ invited/accepted   │
   │ picture_url    │              │ archived_at  │      │ revoked_at         │
   └────────────────┘              └──────────────┘      └────────────────────┘
            │                                                       ▲
            │ N                                                     │
   ┌────────────────┐                                               │
   │ auth_credentials                                               │
   │  install_id    │ ──── 1 install per device per provider        │
   │  provider      │      A user with 3 phones has 3 credential    │
   │  account_id FK │      rows, one account row.                   │
   └────────────────┘                                               │
                                                                    │
   Mobile (one install):                                            │
   ┌────────────────────────────────────────────┐                   │
   │ users.is_local_self=1                      │                   │
   │   google_sub, account_id (nullable)        │                   │
   │                                            │                   │
   │ users.is_local_self=0  ← Ahmad, Kareem…    │                   │
   │   google_sub=NULL, account_id=NULL FOREVER │                   │
   │                                            │                   │
   │ vault_members_mirror (cache from server)   │ ──────────────────┘
   │   per vault, who has what role             │
   └────────────────────────────────────────────┘
```

Customers (the Ahmads) are pure local objects; they are never associated with a Google account.

### Sync topology — mobile ↔ backend ↔ mobile

```
   Phone A (signed in)                Backend (kaata-backend)               Phone B (same account)
   ┌────────────────────┐             ┌──────────────────────────┐          ┌────────────────────┐
   │ event_log          │ POST push   │  /v1/sync/push           │          │ event_log          │
   │  unsynced events   │ ──────────► │  (JWT-gated, vault ACL)  │          │  pull cursor       │
   │  (synced_at=NULL)  │             │                          │          │  (last server_seq) │
   │                    │ GET pull    │  events table            │          │                    │
   │  pull cursor       │ ◄────────── │  (vault_id, server_seq)  │ POST push│  unsynced events   │
   │  (last server_seq) │             │                          │ ─────────│                    │
   │                    │             │  /v1/sync/pull           │          │                    │
   │                    │             │   indexed range scan     │ GET pull │                    │
   │  projection        │             │   on (vault, server_seq) │ ◄────────│  projection        │
   │  (entries, ppl)    │             │                          │          │  (entries, ppl)    │
   └────────────────────┘             │  snapshots table         │          └────────────────────┘
                                      │   (compaction)           │
                                      │                          │
                                      │  Postgres LISTEN/NOTIFY  │
                                      │  (escape hatch for SSE)  │
                                      └──────────────────────────┘
                                                  │
                                                  ▼
                                            kaata-db (Postgres 18)
                                            shared across all backend services
```

Polling: 5s foregrounded, 30s backgrounded. Both push and pull are idempotent via UUID `event_id`.

### Mesh topology (Phase 5)

```
                                SHOP MODE ON
                                     |
            +────────────────────────+────────────────────────+
            |                                                 |
       Phone A (owner)                                  Phone B (assistant)
       ┌───────────────┐                            ┌───────────────┐
       │ event_log     │                            │ event_log     │
       │ CRDT merge    │                            │ CRDT merge    │
       │ VMC (cached)  │                            │ VMC (cached)  │
       │ server pubkey │                            │ server pubkey │
       └───────┬───────┘                            └───────┬───────┘
               │                                            │
       ┌───────┴───────┐                            ┌───────┴───────┐
       │ WebRTC + DTLS │                            │ WebRTC + DTLS │
       └───────┬───────┘                            └───────┬───────┘
               │     \                              /       │
               │      \  data channel  (E2E)       /        │
               │       +─────────────────────────+         │
               │                                            │
       ┌───────┴───────┐    shop WiFi LAN           ┌───────┴───────┐
       │ mDNS pub/brow │◄──────────────────────────►│ mDNS pub/brow │
       │ BLE (fallback)│◄────────BLE radio─────────►│ BLE (fallback)│
       │ WiFi P2P (fb) │◄────direct radio (fb)─────►│ WiFi P2P (fb) │
       └───────────────┘                            └───────────────┘

       When either A or B reaches internet:
           Events pushed to backend via Phase 3 sync; the other phone's
           events ride along automatically (bridging is emergent).
```

### Identity layering (Account / User / Self)

```
 Backend identity                        Mobile identity
 ────────────────                        ────────────────────────────────────

 accounts                                users (mobile SQLite)
 ┌───────────────┐                       ┌──────────────────────────────┐
 │ account_id PK │ ─── 1:0..1 ───        │ is_local_self = 1            │
 │ google_sub UQ │      account_id NULL  │   google_sub  (set on auth)  │
 │ email         │      until sign-in    │   account_id (mirrored)      │
 │ name          │                       │ ─────────────────────────────│
 │ picture_url   │                       │ is_local_self = 0            │
 └───────┬───────┘                       │   "Ahmad", "Kareem", …        │
         │ 1:N                           │   google_sub = NULL always    │
         ▼                               │   account_id = NULL always    │
 vault_members                           └──────────────────────────────┘
   (vault_id, account_id, role)
         ▲
         │ 1:N             one mobile install ←→ one account (most of the time)
         │                 one account ←→ many installs (multi-device)
 auth_credentials
   (install_id, provider, account_id)

 The Self bridge:
   The local-self user is the ONE row in mobile users that may carry
   google_sub / account_id. All other rows (the customers) carry neither,
   forever. Sync events carry actor_account_id, not actor_user_id, so
   "who pressed save" is auth-scoped, not contact-scoped.
```

---

## Glossary (resolves N3 / B4 / cross-doc naming)

Single source of truth for the four overlapping identity words:

- **Account** = the auth identity. A `accounts` row on the backend (UUID PK, `google_sub` UNIQUE). One row per real human who signs in. Always backend-side.
- **Local user** = a `users` row on mobile. May be the **local-self** (the shopkeeper using this device) OR a contact (Ahmad, Kareem, …). All ledger reads & writes reference `users.id` (a device-local UUID).
- **Self** = the local-self `users` row (`is_local_self = 1`). The one row that may carry `google_sub` and `account_id`. Every other `users` row carries NULL for both, forever.
- **Member** = the binding row `(vault_id, account_id, role)` — `vault_members` on the backend, mirrored to `vault_members_mirror` on mobile.
- **Author** = the account that emitted an event = `events.account_id` (backend) = `actor_account_id` (mobile event_log). `actor_user_id` on mobile is the **device-local** users.id of the local-self at the time of authoring; it is **not portable across devices** and is only used by the local audit UI.

### Wire format conventions

- All UUIDs on the wire and in mobile SQLite are RFC 4122 lowercase 36-char strings (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Backend stores native `UUID`; pgx parses via `uuid.Parse` which rejects uppercase and missing hyphens. Mobile `install_id` is guaranteed UUIDv4 (existing invariant); any non-UUID-shaped value coming up from a legacy install is reported in check-in telemetry and the install is stamped "needs reprovisioning."
- Event timestamps on the wire are integer ms since Unix epoch.
- The single name for the per-vault sync cursor is **`server_seq`** (see §Decisions). Request param: `?after_server_seq=N`. Response field: `next_after_server_seq`. Push payloads do **not** carry a cursor (server assigns it).
- Event type strings use **underscored** form (`entry_created`, never `entry.created`). The Phase 3 push example below has been corrected.
- i18n keys use UI semantics (`shop.settings.archive`); code identifiers use storage semantics (`vault_id`, `VaultPickerSheet`). A single helper `i18n.shopLabel({vault_id})` maps between them.

---

## Decisions Log (with rationale)

### Identity: Google auth only; phone OTP deferred

**Decision:** `@react-native-google-signin/google-signin` v15.x is the only auth provider in this plan. Phone OTP returns when Afghan SMS infra becomes viable.

**Rationale:** Founder's `auth_model_decision.md` already locked this. The Google ID is an auth credential, not the canonical user identity — `phone_e164` on `users` remains the canonical identity for customers (the Ahmads), and is irrelevant for the shopkeeper's auth path. The "phone is canonical identity" principle is preserved at the data layer; only the _authentication mechanism_ for the shopkeeper differs.

**Bridge:** mobile `users` gets two new nullable columns (`google_sub`, `account_id`) populated only on the `is_local_self=1` row. See §Schema and §Phase 2.

### Encryption: none beyond TLS

**Decision:** Server stores plaintext ledger data. No envelope encryption, no E2EE, no opaque blobs.

**Rationale:** The long-term play is AI training on aggregated shopkeeper data. Server-readable is required. Users who do not sign in produce data that never leaves the device. This is the trust contract.

**Risk acknowledgment:** Documented in §Threat Model (Phase 2 D3). The biggest residual risk is Google account takeover; we rely on Google's 2FA, not our own.

### Naming: `vault` internally, "Shop" / "دکان" in the UI

**Decision:** Code uses `vault_id`, `vault_members`, etc. UI labels say "Shop" (English) and "دکان" (Dari).

**Rationale:** D2 makes a strong case for `shop` everywhere, but D5/D6/D9 already use `vault` in API paths and table names. **Resolution:** internal vocabulary (DB columns, API routes, function names) uses `vault` because it carries less semantic baggage when we later add non-shop vaults (e.g., personal lending circles). User-visible strings use `shop`/`دکان` because that's what Afghan shopkeepers actually call it. This is a translation table, not a contradiction.

**Internal contradiction resolved:** D2 vs D5/D9. D2 wins for user-facing copy; D5/D9 win for code identifiers.

### CRDT approach: custom op-based, no library

**Decision:** Hand-rolled merge on top of the event log. Per-field LWW by HLC for the handful of mutable fields. Sticky tombstones for deletes. No Automerge, Yjs, or Loro.

**Rationale (one paragraph):** Kaata has fewer than 10 mutable fields across its entire schema (entry amount/note, person name/phone, vault role, vault setting key/value). Everything else is append-only by nature. Pulling in 200–600KB of WASM/JS to manage 5 fields means shipping a foreign mental model on Hermes that fights the SQLite-as-truth invariant the codebase already enforces. The merge function is ~500 LOC of TypeScript including HLC arithmetic; the hard parts (HLC, snapshot/restore, sync protocol) are ones a library wouldn't solve for us anyway. Library swap path stays open: all merge logic lives in `lib/projection/*.ts`, so if we ever ship collaborative rich text we can swap.

### Logical clock: HLC, end-to-end (resolves C1)

**Decision:** Hybrid Logical Clock — `(physical_ms, logical_counter, device_id)`. Stored as three columns on mobile `event_log` AND three columns on backend `events` (`hlc_physical_ms`, `hlc_logical`, `hlc_device_id`). The wire format on push and pull carries all three. There is **no separate Lamport clock** anywhere.

**Rationale:** Lamport loses real wall-clock ordering (UI needs "this happened at 2pm"). Vector clocks grow unbounded as devices join. HLC is bounded per-event, preserves causality, monotonic across clock skew, and battle-tested by CockroachDB and MongoDB.

**Tiebreaker:** `hlc_device_id` lexicographic, final and deterministic. UUIDv4 install_ids give a uniform random tiebreak — there is no "owner wins" semantic by design. If users ever complain, the future iteration adds `(device_first_seen_at, device_id)` as the tiebreaker, but that requires bumping the HLC wire format and is deferred.

**Schema impact (overrides earlier backend schema in §Schema Specifications):** the Phase 3 backend `events` table uses `hlc_physical_ms BIGINT NOT NULL`, `hlc_logical BIGINT NOT NULL`, `hlc_device_id UUID NOT NULL` — NOT `lamport` + `wallclock_unix_ms`. See "Schema corrections" subsection below.

**Concurrency:** mobile `appendEvent` performs the HLC tick **inside the same SQLite transaction** as the event_log INSERT. `app_meta.hlc_last` is stored as JSON `{"pms":…,"l":…,"did":…}` and read with the transaction lock; WAL mode gives serial-equivalent semantics. Two parallel `appendEvent` calls cannot produce duplicate HLCs.

### Sync transport: HTTP/1.1 short polling + gzip

**Decision:** `POST /v1/sync/push` + `GET /v1/sync/pull?vault_id=<uuid>&after_server_seq=<n>`. JSON over HTTP. Gzip both directions. 5s polling foreground, 30s background.

**Rationale (D5):** Solo founder. SSE/WebSocket means tuning Caddy/Dokploy proxy timeouts, mobile network suspend handling, reconnect-with-Last-Event-ID logic. Polling is `setInterval` plus a pull endpoint we need anyway. 2–5 second sync is fine for a ledger (no real-user data demands sub-second, and dogfooding confirms 5s feels instant for the add-entry-on-A → see-on-B path).

**Sync worker ordering contract (resolves C1):** the mobile sync worker **always awaits a pull-to-completion (`has_more = false`) before initiating a push**. This is non-negotiable. Push-before-pull risks the demoted-user batch-rejection failure mode (8h offline, owner demoted you, your entire offline batch dies on the floor even though all edits were lawful when made). Documented in Phase 3 done criteria; enforced in `apps/mobile/lib/sync/scheduler.ts`. **Backend rejection rule** to complement this: events carry an HLC; if `hlc_physical_ms` falls inside a member's lawful role window per `vault_audit_log`, the event is accepted at that role even if the _current_ role would reject. Otherwise, fully-offline users lose legitimate pre-demotion work.

**Pagination cursor naming (resolves N4):** **`server_seq`** is the single name. The request param is `?after_server_seq=N`. The response field is `next_after_server_seq`. The push payload does NOT carry a cursor (server assigns `server_seq` on insert).

**Per-vault `server_seq` (resolves C2):** Backend `server_seq` is assigned **per-vault**, not globally — `(vault_id, server_seq)` is UNIQUE, the next value is assigned inside the same transaction as the insert via `SELECT COALESCE(MAX(server_seq), 0) + 1 FROM events WHERE vault_id = $1` under a `SELECT … FOR UPDATE` lock on the `vaults` row. This (a) eliminates the gap-in-sequence bug a global `BIGSERIAL` would create under concurrent commits (where a cursor advancing past `seq=101` could permanently skip an in-flight `seq=100`), (b) lets pull pagination return the correct "next event in this vault" cursor, and (c) makes a future vault-shard strategy clean. Cost: one extra index lookup per push; pushes for the same vault are rare across devices, so contention is negligible. There is no separate global `BIGSERIAL` column for debugging — if needed later, add a non-load-bearing `internal_id BIGSERIAL` for ops logs only.

**Escape hatch — explicit path:** Postgres `LISTEN/NOTIFY` is **only** considered when concurrent signed-in users exceed ~500 (the practical Postgres backend ceiling for a single listener-per-client topology, since `LISTEN` consumes a dedicated connection). At that point, the escape hatch is a single notify-listener goroutine in the backend that fans out to in-memory subscribers — NOT one `LISTEN` per client. Past ~5000 concurrent users we adopt Redis pub/sub and pay the operational cost. The "polling exceeds 50% backend CPU" trigger from earlier drafts of this doc is wrong as a primary criterion — concurrent connection count is the real one.

### Mesh discovery: mDNS-first, BLE/WiFi-Direct fallback

**Decision (Phase 5 only):** Primary discovery is mDNS over shop WiFi (`_kaata-mesh._tcp.local.`). Fallback is BLE advertise + WiFi-Direct handoff for off-WiFi cases. QR pairing for the one-time bootstrap (transfers signed Vault Membership Credential).

**Transport:** WebRTC data channels over the discovered transport. DTLS gives free encryption; ICE handles LAN AP isolation and firewall quirks.

**Rationale (D6):** Almost every Afghan shop with multiple phones has WiFi. mDNS is cheap (passive radio), well-supported on Android NSD, and works iOS↔Android. BLE alone is too slow for our payloads but is good for "is anyone nearby?" presence.

### Backup unification with sync

**Decision (D5 §7):** Deprecate the current standalone `/v1/backup/upload` + `/v1/backup/latest` once v0.7.0 is the floor. Backup-only users are just a sync vault with one member and one device.

**Migration (resolves C7 / S4):** v0.4.x clients keep using `/v1/backup/*`. v0.5.0 clients emit sync push exclusively. On v0.5+ first-launch with an existing v0.4 backup row, the import path decodes the backup JSON and **emits one clean event per row** (`person_added` per person, `entry_created` per entry, plus `shop_profile_updated`), with HLC values derived from `created_at` and `hlc_device_id = "v04-backfill-<install_id>"`. There is **no synthetic "import_from_v04_backup" mega-event** — that approach was rejected because a single event with a 500-row payload blows past the 64 KiB-per-payload limit AND a second device pulling the import event cannot project from it. The decoded events fit the normal CRDT pipeline. Guard: the import path **only fires if `event_log` is empty for the target vault** — otherwise the local event log is canonical and the backup is discarded.

**Deprecation gate (resolves S4):** the `/v1/backup/*` endpoints are removed on a **fixed date: 2026-12-01**, not on a "%-of-installs" threshold. The threshold approach never triggers cleanly when v0.4 users have already churned; a date forces the conversation. Last-mile v0.4 installs receive a `min_supported_version=0.7.0` force-update during the window. This is exactly what the existing release flow supports.

### Sync Authority Model (resolves B1)

**Decision:** There is **no separate "resolver" abstraction**. The deterministic per-field LWW merge function IS the resolver, and it runs in **both** TypeScript (mobile) and Go (backend).

1. **Server is the append authority.** Server assigns `(vault_id, server_seq)`, validates Phase 4 permissions, and rejects events whose author lacked the role at the event's HLC. Server never overwrites payloads, never re-orders events.
2. **Both server and client are projection authorities.** Both run the same deterministic merge function (HLC-ordered, per-field LWW, sticky tombstones). Both produce byte-identical projections from the same event stream — gated by a shared JSON conformance corpus in `apps/_shared/projection-corpus/` consumed by both Go and TS test suites.
3. **The merge function is the resolver.** Located at `apps/mobile/lib/projection/merge.ts` and `apps/backend/internal/sync/project.go`. Neither imports the other; both pass the corpus.

### Server-side projection — keep it, but understand the recurring tax

**Decision:** Server runs the projection (Go side) only for snapshot generation. It does NOT compute live state for read endpoints; clients are always the live-state authority.

**Cost acknowledgment:** Every new event type costs ~1 extra dev day to maintain Go parity + add a corpus fixture. This is the single largest recurring tax in the plan. Open Question 11 asks whether to skip Go projection entirely and have new devices download the full event log on first sync; if that becomes attractive (after the first 2-3 painful event-type additions), we revisit and delete `vault_snapshots`. **For the v0.7.0 ship, projection equivalence stays.**

### Event payload schemas (resolves A1)

Every event type's `payload` JSON shape is canonical. New event types require: (a) a CHECK constraint update on mobile (Note: see Decision below on dropping CHECK), (b) an applier entry in the projection registry, (c) a Go counterpart in `project.go`, (d) a corpus fixture. No other path is supported.

| Event type                                          | Payload shape                                               | Notes                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `entry_created`                                     | `{entry_id, relationship_id, type: 'debt'                   | 'payment', amount_afn, note, occurred_at_ms}`                                                          | `type` is internal terminology (UI says "I gave"/"I received") |
| `entry_amended`                                     | `{changes: {field: new_value, ...}}`                        | **Delta only**, NOT full state — LWW-by-field needs to know which fields the author intended to change |
| `entry_deleted`                                     | `{}`                                                        | Sticky tombstone; later `entry_amended` to the same target_id is ignored                               |
| `entry_settled`                                     | `{settled_at_ms}`                                           | Phase 4 reserved                                                                                       |
| `person_added`                                      | `{user_id, name, phone_e164, relationship_context: 'peer'}` | `user_id` is the local UUID; for cross-device, see person-identity decision below                      |
| `person_renamed`                                    | `{name}`                                                    |                                                                                                        |
| `person_phone_changed`                              | `{phone_e164}`                                              |                                                                                                        |
| `person_archived` / `person_unarchived`             | `{}`                                                        |                                                                                                        |
| `shop_profile_updated`                              | `{changes: {field: new_value, ...}}`                        | Delta only                                                                                             |
| `vault_setting_set`                                 | `{key, value}`                                              |                                                                                                        |
| `vault_member_added` / `_role_changed` / `_removed` | `{account_id, role}`                                        | Phase 4                                                                                                |
| `account_bound`                                     | `{from_user_id, account_id, retroactive_through_event_id}`  | See "Pre-sign-in events" decision below                                                                |

### Event log abstraction (resolves A2 / A4 / B2)

**Single `applyEvent` entry point.** `applyEvent(event, {origin: 'local' | 'remote'}): {applied: boolean}` is the only way events enter the system. Idempotent by `event_id` (INSERT OR IGNORE). Transactional: append + project + cursor advance, all-or-nothing. The remote path is the same path. There is no separate `applyRemoteEvent`. Both the HTTP sync worker and the Phase 5 mesh transport call this; they do not write to the event log directly.

**Transport interface (resolves B2):**

```ts
interface EventTransport {
  push(events: LedgerEvent[]): Promise<{ accepted: string[]; rejected: Rejection[] }>;
  pull(vaultId: string, since: ServerSeqCursor): AsyncIterator<LedgerEvent>;
}
```

HTTP sync (`lib/sync/push.ts` + `lib/sync/pull.ts`) and Phase 5 mesh (`lib/mesh/transport.ts`) both implement this. `synced_at` is renamed to `server_acked_at` for clarity — it is a per-device-outbox flag, never a global property. Two devices independently track `server_acked_at` for the same event.

**Projection applier registry (resolves A4):**

```ts
type ProjectionApplier<E extends LedgerEvent> = (
  db: Transaction, event: E
) => Promise<void>;
const APPLIERS: Record<EventType, ProjectionApplier<any>> = { ... };
```

Adding a new event type means: (a) widen the type union in `lib/events.ts`, (b) add an applier here, (c) add the Go counterpart, (d) add a corpus fixture. Nothing else.

### Drop the event_type CHECK constraint (resolves S1)

**Decision:** Mobile `event_log.event_type` is **not** a CHECK constraint. Validation lives in the projection applier registry — unknown types are rejected at insert time by `applyEvent`. SQLite CHECK widening requires table-rewrite, which is debt every time we add an event type. The earlier Phase 3 migration 009 plan called for a rename+copy of `event_log` purely to widen the CHECK — that work is dropped.

Backend `events.event_type` is also a plain `TEXT NOT NULL` validated in Go. Wire format is the underscored form (`entry_created`), enforced by the Go enum table at the handler.

### Drop supersedes_event_id (resolves C2 / C8 partial)

**Decision:** The earlier `supersedes_event_id` / `prev_event_id` chain pointer is **removed**. LWW-by-HLC does not need it. The chain pointer added: (a) out-of-order delivery handling complexity (parking-lot semantics for unknown predecessors), (b) cycle-detection burden, (c) inconsistent naming between mobile and backend, (d) no documented use case beyond audit "intent."

If audit intent surfaces as a real Phase 4 need ("show me Alice's edits in causal order"), it is computed at query time from HLC ordering, not from a chain column. The audit screen does not need event-graph topology to read.

### Vault provisioning — first-login does NOT mint a server-side vault (resolves C5)

**Decision:** On first Google sign-in, the backend creates only an **account** row (no default vault). The mobile client, which already has a `vaults` row from migration 008 (or from manual onboarding), then calls `POST /v1/vaults` with **its existing vault_id** to register it server-side. Server accepts the client-provided UUID (rejects only if it collides with an existing one, which is statistically impossible for v4 UUIDs).

This eliminates the double-mint race where the migration-008 vault and the server's "default vault on first login" had different UUIDs and no reconciliation rule. The client is the source of truth for vault identity.

**Compat:** the `pending_vault_registration` field on the auth request is kept for cases where the mobile install has not yet run migration 008 (rare, mid-onboarding). If present, the server creates a vault with the client-provided UUID and name. If absent, no vault is created; the next `POST /v1/vaults` from mobile does the registration.

### Pre-sign-in events: `account_bound` retroactive event (resolves S3 / A5 / m2)

**Decision:** Mobile event log is **strictly append-only**. We never mutate `actor_account_id` on existing events when the user signs in 6 months later. Instead, the moment a user signs in, mobile appends a single synthetic event:

`account_bound { from_user_id, account_id, retroactive_through_event_id }`

Backend projection treats every event with `event_id <= retroactive_through_event_id` on the same vault as authored by `account_id` for ACL purposes. This:

- Preserves append-only purity.
- Gives Phase 4 audit log honest history (pre-sign-in events are tagged "claimed by this account on <date>").
- Lets the pre-sign-in events finally sync (server sees them as authored by a valid account).

`actor_account_id` on the events themselves stays NULL pre-binding; the projection consults the most recent `account_bound` event to derive the effective author.

`actor_user_id` on the mobile event_log is renamed `author_user_id_local_only` (or kept with a comment) — it is the device-local users.id at the time of authoring, useless across devices, NEVER sent over the wire.

### Person identity across devices (defers full multi-vault uniqueness; resolves S6)

**Decision:** `users.phone_e164` UNIQUE constraint is **device-local-vault-scoped, not device-wide**. Phase 2 migration 007 replaces the existing single-column UNIQUE on `users.phone_e164` with a partial unique index `ON (vault_id_of_relationship, phone_e164)` via a join through `relationships` — implemented by moving phone uniqueness enforcement out of `users` and into the `createPerson`/`updatePerson` code paths that already have vault context. The DB-level UNIQUE on `users.phone_e164` is dropped.

This avoids the head-on collision in Phase 4 where the same phone number appears in two vaults legitimately (e.g., Ahmad is a customer of Shop A AND a customer of Shop B). Existing `archivePerson` workaround that nulls `phone_e164` stays but is no longer load-bearing.

### Encryption + AI training: trust contract, retention, and deletion

**Decision (refines existing encryption-none decision):** Server stores plaintext ledger data including customer names and phone numbers. This is explicitly logged for potential AI training. The trust contract:

- **What we collect:** every event payload including names, phone numbers, amounts, notes.
- **What we do NOT collect:** Google ID tokens (verified and discarded at request time), customer biometric data, location.
- **Account deletion path:** `POST /v1/accounts/delete` (Phase 4) sets `accounts.disabled_at`, revokes all `vault_members` rows, and runs an audit-log redaction step that nulls `vault_audit_log.actor_id` while denormalizing the actor's name into `payload.actor_name_at_time`. This preserves the audit log integrity post-deletion without keeping personal data linked to a deleted account.
- **`events.account_id` post-deletion:** events authored by deleted accounts have `account_id` nulled and `payload.author_email_at_time` denormalized. The events are not deleted — vault co-owners' record stays intact.
- **`name` claim trust:** Google ID tokens do not include claimed-name verification. A user can set their account name to anything. The audit log captures the name _as Google asserts it at sign-in time_, not user-mutable input.

### Token lifecycle (resolves M2 / AU3)

- **Session JWT:** 30 days, issued on `/v1/auth/google` success, refreshed silently in every `/v1/check-in` response that succeeds (rolling refresh). No separate refresh token.
- **Revocation:** `auth_credentials.revoked_at` is checked on every protected request via the 60s-LRU membership cache (extend cache to include `revoked_at`). Setting `revoked_at` kills sessions on the next request. A `POST /v1/auth/revoke-all-sessions` endpoint in Phase 4 sets `revoked_at = NOW()` for all of an account's `auth_credentials` rows — the "lost phone" recovery path.
- **VMC (Phase 5):** 60-day lifetime, refreshed via `POST /v1/vaults/:vault_id/credential`. Tied to `vault_epoch` — any role mutation bumps the vault's epoch, invalidating all VMCs from prior epochs at the next handshake.
- **Both JWT and VMC anchor to the same `account_id`.** Either can be revoked server-side by deleting `auth_credentials` (kills JWT next request) and bumping `vault_epoch` (kills VMC next handshake).

### Email normalization for invites (resolves AU2)

**Decision:** Before storing `invite_email` on `vault_members` or comparing to a Google ID token email, normalize: trim, lowercase, and for `*@gmail.com` strip dots from the local part (`m.atee@gmail.com` → `matee@gmail.com`). Store the normalized form. The web invite landing page applies the same normalization when matching.

### "Different account" detection rule (resolves AU4)

**Decision:** The "Different account on this phone?" `ConfirmDialog` fires when (a) the mobile install has a previously-stored `google_sub`, AND (b) the new token's `sub` differs from it, AND (c) the prior `sub` was last seen <30 days ago. After 30 days, treat as fresh sign-in (no dialog). Mobile-stored `google_sub` is advisory only; server-side `accounts.google_sub` is authoritative.

### Vault epoch bumps in Phase 2, not Phase 5 (resolves A3)

**Decision:** `vaults.vault_epoch BIGINT NOT NULL DEFAULT 0` moves from the Phase 5 migration 008 into **Phase 2 migration 006**. Phase 4's role-change service bumps it on every membership mutation (add/role-change/revoke). This way, when Phase 5 ships, VMCs have a real epoch history to anchor revocation freshness against — no blind spot for pre-Phase-5 role changes.

### Backend gzip decompression bomb defense (resolves M6)

**Decision:** `gzhttp.MaxDecompressedSize(16 << 20)` (16 MiB) on the gzip decoding middleware. A 1 MiB compressed body that decompresses to >16 MiB is rejected with `413 Payload Too Large`. Independent of the 1 MiB compressed body limit, this caps the OOM blast radius from a hostile or buggy client.

### Postgres event payload size enforcement (resolves M3)

**Decision:** `events.payload JSONB` has a schema-level `CHECK (pg_column_size(payload) < 65536)` (64 KiB). `vault_snapshots.snapshot` has `CHECK (pg_column_size(snapshot) < 52428800)` (50 MiB) — if a snapshot exceeds this, the snapshot generator must split the vault or fail loud. These checks complement the handler-level limits and survive accidental handler-bypasses.

### `device_privkey` lives in SecureStore, not SQLite (resolves C4 / S5)

**Decision:** Resolved before Phase 5 begins. The mesh device Ed25519 private key is stored **only** in `expo-secure-store` under key `mesh-device-key-<install_id>`. Mobile SQLite stores only `device_pubkey` and the VMC blob; the `device_privkey` column is removed from migration 011. `vmc.ts` fetches the privkey on demand. SecureStore's iOS 2KB limit is respected — Ed25519 privkey is 32 bytes, well under.

### Snapshot generation isolation (resolves M1)

**Decision:** The snapshot cron uses a **separate Postgres connection pool** with `MaxConns = 4`, distinct from the user-facing pool. The cron reads only events with `server_seq > prior_snapshot.up_to_server_seq` (delta replay over the prior snapshot, not full event log), and has a "skip if snapshot generated within last hour" guard. Lives in the existing `kaata-backend` container — Open Question 11 is **resolved** to "single container with isolated pool."

### Invite token spec (resolves M5)

**Decision:** `invite_token = base64url(crypto.randomBytes(32))` — 256 bits of entropy. `invite_expires_at` is capped at 7 days from creation. Per-token rate limit: 5 accept attempts per hour, 20 lifetime; the 21st attempt auto-revokes the invite (`revoked_at = NOW(), revoked_reason = 'too_many_attempts'`). Owner has `POST /v1/vaults/:vid/invites/:id/revoke` to manually revoke before expiry.

### Library choices summary

| Domain                           | Library                                     | Version        | License    | Bundle impact  | Notes                                                                                                              |
| -------------------------------- | ------------------------------------------- | -------------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Google sign-in (mobile)          | `@react-native-google-signin/google-signin` | ~15.x          | Apache-2.0 | Native, ~1 MB  | Already in `app.json:35`                                                                                           |
| Google ID token verify (backend) | `google.golang.org/api/idtoken`             | latest         | BSD-3      | —              | Already in `auth/service.go:62`                                                                                    |
| HTTP router (backend)            | `github.com/go-chi/chi/v5`                  | v5             | MIT        | —              | Already in use                                                                                                     |
| Postgres driver (backend)        | `github.com/jackc/pgx/v5`                   | v5             | MIT        | —              | Already in use                                                                                                     |
| JWT (backend)                    | `github.com/golang-jwt/jwt/v5`              | v5             | MIT        | —              | Already in use                                                                                                     |
| HTTP gzip (backend)              | `github.com/klauspost/compress/gzhttp`      | latest         | Apache-2.0 | —              | New for sync                                                                                                       |
| UUIDs (backend)                  | `github.com/google/uuid`                    | latest         | BSD-3      | —              | New                                                                                                                |
| Membership cache (backend)       | `github.com/hashicorp/golang-lru/v2`        | v2             | MPL-2.0    | —              | New, 60s TTL                                                                                                       |
| WebRTC (Phase 5 mobile)          | `react-native-webrtc`                       | ~124           | MIT        | ~6–8 MB native | EAS dev client required                                                                                            |
| mDNS (Phase 5 mobile)            | `react-native-zeroconf`                     | ~0.13          | MIT        | ~50 KB         | Android NSD wrapper                                                                                                |
| BLE (Phase 5 mobile)             | `react-native-ble-plx`                      | ^3             | Apache-2.0 | ~1 MB native   | Polidea/DotIntent                                                                                                  |
| WiFi-Direct (Phase 5)            | `react-native-wifi-p2p`                     | ^3             | MIT        | ~200 KB        | **TBD:** verify maintenance at Phase 5 start; may need to write Expo Module                                        |
| Ed25519 (Phase 5)                | `@noble/ed25519`                            | latest         | MIT        | ~30 KB         | Pure JS, Hermes-safe                                                                                               |
| QR scan (Phase 5)                | `expo-camera`                               | bundled SDK 54 | MIT        | 0              | Already in tree                                                                                                    |
| UUIDs (mobile)                   | `Crypto.randomUUID()` (v4)                  | bundled        | MIT        | 0              | Accept random B-tree inserts; UUIDv7 dropped — HLC is the causal ordering source, not UUID lex order (resolves C5) |
| UUIDv5 helper (mobile)           | inline 30-line helper                       | —              | —          | <1 KB          | For migration-006 deterministic backfill IDs                                                                       |

Rejected: Automerge, Yjs, Loro, Replicache (license + server-authoritative conflict with local-first), libp2p (oversized for this plan), Firebase Auth, Auth0, Clerk.

---

## Schema Specifications

All migrations are append-only. Numbering continues from the existing schema (mobile: 005+, backend: 006+). Existing migrations 001–004 (mobile) and 001–005 (backend) are not modified.

### Mobile (SQLite) — by phase

#### Phase 1 schema (migration 005, 006)

**Migration 005 — `005_event_log`** creates the event log and adds projection-cache columns.

```sql
-- The event log: source of truth, append-only
-- Note: event_type is NOT a CHECK constraint (resolves S1; see Decisions Log).
-- Validation lives in the projection applier registry.
CREATE TABLE event_log (
  event_id            TEXT PRIMARY KEY,           -- UUIDv4 (Crypto.randomUUID); see Decisions: UUIDv7 dropped
  event_type          TEXT NOT NULL,              -- underscored form: entry_created, etc.

  vault_id            TEXT,                       -- nullable for now; backfilled in Phase 2
  target_id           TEXT NOT NULL,              -- generalized from day one (was entry_id; resolves C4)
                                                  --   for entry events: the entry_id
                                                  --   for person events: the users.id
                                                  --   for vault_member events: the account_id
  relationship_id     TEXT,                       -- nullable; only set on entry events

  -- HLC, three components, end-to-end (resolves C1)
  hlc_physical_ms     INTEGER NOT NULL,
  hlc_logical         INTEGER NOT NULL,
  hlc_device_id       TEXT    NOT NULL,

  device_id           TEXT    NOT NULL,           -- == hlc_device_id, kept for query clarity
  author_user_id_local_only TEXT NOT NULL,        -- device-local users.id of author; never sent over wire (resolves m2)
  actor_account_id    TEXT,                       -- NULL until Google sign-in (Phase 2); see account_bound event

  -- supersedes_event_id REMOVED — chain pointer dropped (see Decisions: "Drop supersedes_event_id")

  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),  -- resolves m4
  payload_schema      INTEGER NOT NULL DEFAULT 1,                       -- forward compat (resolves m4)

  appended_at         INTEGER NOT NULL,           -- local wall-clock at insert
  server_acked_at     INTEGER,                    -- NULL until backend ack (renamed from synced_at for clarity; resolves B2)
  rejected_at         INTEGER,                    -- non-null when server rejected this event (resolves "synced_at = -1" sentinel TBD)
  origin              TEXT    NOT NULL DEFAULT 'local'
                              CHECK (origin IN ('local','remote','backfill'))
);

CREATE INDEX idx_event_log_target        ON event_log(target_id, hlc_physical_ms, hlc_logical, hlc_device_id);
CREATE INDEX idx_event_log_relationship  ON event_log(relationship_id, hlc_physical_ms) WHERE relationship_id IS NOT NULL;
CREATE INDEX idx_event_log_unsynced      ON event_log(appended_at) WHERE server_acked_at IS NULL AND rejected_at IS NULL;

-- Projection columns on existing entries table
ALTER TABLE entries ADD COLUMN current_event_id TEXT;
ALTER TABLE entries ADD COLUMN is_deleted        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN is_settled        INTEGER NOT NULL DEFAULT 0;
UPDATE entries SET is_deleted = 1 WHERE deleted_at IS NOT NULL;
```

**Note on `target_id` (resolves C4):** mobile uses `target_id` from day one, even though every value in Phase 1 will be an entry_id. This avoids the Phase 3 rename pain. The Phase 1 replay-test continues to filter by `target_id`.

**Migration 006 — `006_backfill_events`** replays existing rows as synthetic events.

For each non-deleted entry, insert one `entry_created` event with HLC `(created_at, 0, install_id)`. For each entry with `updated_at > created_at + 1000ms`, also insert a synthetic `entry_amended` event with `backfill_synthetic: true` flag (we cannot recover the pre-amendment value). For each soft-deleted entry, insert `entry_deleted` at `deleted_at`.

All backfilled rows have `origin='backfill'` and `synced_at=NULL` so they upload on the next sync. Event IDs are deterministic: `uuid5(namespace, "${kind}:${target_id}:${hlc_physical_ms}")` — running migration 006 twice is a no-op via `ON CONFLICT(event_id) DO NOTHING`.

#### Phase 2 schema (migration 007 — merged from prior 007+008)

**Migration 007 — `007_vaults_and_auth_binding_and_backfill`** is a **single atomic migration** (resolves m7). Combining schema creation and backfill in one transaction means: if the migration fails partway, `schema_migrations` row is absent and it re-runs cleanly. Previously, splitting into 007 (rename) + 008 (backfill) created a window where a crash between them left `shop_profile` empty, sending the user to onboarding (catastrophic data loss UX).

```sql
-- The vault container
CREATE TABLE vaults (
  id                          TEXT PRIMARY KEY,         -- UUID v4
  name                        TEXT NOT NULL,
  currency                    TEXT,                     -- ISO 4217; NULL = inherit device default
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  archived_at                 INTEGER,                  -- soft delete
  is_default                  INTEGER NOT NULL DEFAULT 0,
  registered_with_server_at   INTEGER,                  -- NULL until first sync
  vault_epoch                 INTEGER NOT NULL DEFAULT 0,   -- resolves A3 (bumped on every membership change)
  hlc_logical                 INTEGER NOT NULL DEFAULT 0,
  hlc_wall_ms                 INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_vaults_active ON vaults(archived_at) WHERE archived_at IS NULL;

-- Local mirror of server-side vault_members (for permission checks + UI)
CREATE TABLE vault_members_mirror (
  vault_id        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  accepted_at     INTEGER,
  revoked_at      INTEGER,
  PRIMARY KEY (vault_id, account_id)
);

-- Add account binding to the local-self user
ALTER TABLE users ADD COLUMN google_sub  TEXT;
ALTER TABLE users ADD COLUMN account_id  TEXT;
CREATE UNIQUE INDEX idx_users_google_sub
  ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Add vault_id to ledger tables (nullable during backfill, then rewritten to NOT NULL below)
ALTER TABLE entries        ADD COLUMN vault_id TEXT;
ALTER TABLE relationships  ADD COLUMN vault_id TEXT;

-- shop_profile rebuild: rename old, create new, BACKFILL with placeholder, then drop old
-- All in the same transaction; no inter-migration window (resolves m7)
ALTER TABLE shop_profile RENAME TO _old_shop_profile;
CREATE TABLE shop_profile (
  vault_id    TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  owner_name  TEXT,
  shop_name   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ===== BACKFILL (same migration, same transaction) =====
-- 1. Mint the default vault if a local-self exists
-- (Pseudocode in migration runner: looks up shop name from _old_shop_profile, mints vault)
-- INSERT INTO vaults(id, name, currency, is_default, created_at, updated_at)
--   SELECT $newVaultId, COALESCE(NULLIF(shop_name,''), 'My ledger'), NULL, 1, $now, $now
--   FROM _old_shop_profile WHERE id=1;
-- 2. Copy shop_profile across
-- INSERT INTO shop_profile(vault_id, owner_name, shop_name, created_at, updated_at)
--   SELECT $newVaultId, owner_name, shop_name, created_at, updated_at FROM _old_shop_profile WHERE id=1;
-- 3. Stamp vault_id on all rows
-- UPDATE relationships SET vault_id = $newVaultId WHERE vault_id IS NULL;
-- UPDATE entries        SET vault_id = $newVaultId WHERE vault_id IS NULL;
-- UPDATE event_log      SET vault_id = $newVaultId WHERE vault_id IS NULL;

-- ===== ENFORCE vault_id NOT NULL via table rewrite (resolves C6) =====
-- "vault_id is nullable, app code enforces non-null" is not enforcement.
-- SQLite CAN add NOT NULL via table-rewrite. We do it here, in the same migration:
-- (Pseudocode:)
-- CREATE TABLE entries_new (... vault_id TEXT NOT NULL REFERENCES vaults(id), ...);
-- INSERT INTO entries_new SELECT * FROM entries;
-- DROP TABLE entries; ALTER TABLE entries_new RENAME TO entries;
-- Same for relationships.

CREATE INDEX idx_entries_vault_created
  ON entries(vault_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_relationships_vault
  ON relationships(vault_id, archived_at) WHERE archived_at IS NULL;

-- ===== Phone uniqueness: drop global UNIQUE, replace with per-vault enforcement (resolves S6) =====
-- The existing UNIQUE on users.phone_e164 fights multi-vault. Drop it.
DROP INDEX IF EXISTS sqlite_autoindex_users_2;  -- or whatever the auto index name is; do via table rewrite if needed
-- App-layer enforcement: createPerson/updatePerson check uniqueness within the calling vault's
-- relationship set: WHERE phone_e164 = ? AND vault_id_of_active_relationship = ?

-- ===== Local-only schema event-sourcing for users/relationships/shop_profile (moved up from Phase 3; resolves C7) =====
-- Phase 1 introduced event_log for entries only. Phase 2 now flips writes for users,
-- relationships, and shop_profile to also go through appendEvent(). Reads stay on the
-- projection. Without this, Phase 2→3 deploy window has unsynced direct-SQL mutations
-- that migration 009 cannot backfill.

-- Drop the _old_shop_profile only after the backfill copy is confirmed
DROP TABLE _old_shop_profile;
```

**Invariant enforced in code (not SQL):** `users.google_sub` and `users.account_id` are non-null only when `is_local_self = 1`. `createPerson()` at `apps/mobile/lib/db.ts:571` asserts both are NULL for `is_local_self=0` inserts.

**No separate migration 008.** Backfill is part of 007 above. The previous "008_backfill_default_vault" plan is dropped; the same logic is now atomic with the schema change.

#### Phase 3 schema (migration 008)

**Migration 008 — `008_sync_metadata`**. Tiny and additive — no event_log table rewrite is needed because (a) Phase 1 already used `target_id` from day one (resolves C4), (b) the CHECK constraint on `event_type` was never added (resolves S1), and (c) `supersedes_event_id` was dropped from the schema before being introduced. The Phase 3 mobile work is purely additive.

```sql
-- Per-vault sync cursors (one row per vault the user has synced)
CREATE TABLE sync_state (
  vault_id                  TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  last_pulled_server_seq    INTEGER NOT NULL DEFAULT 0,    -- cursor name standardized (resolves N4)
  last_pull_at              INTEGER,
  last_push_at              INTEGER,
  last_error                TEXT,
  last_error_at             INTEGER
);

-- Projection conflict surface (moved up from Phase 4; resolves A5)
-- Phase 3 sync can already produce phone-uniqueness collisions, so the table must exist now.
CREATE TABLE projection_conflicts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,
  vault_id            TEXT,
  detail_json         TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER
);
```

No `event_log` rewrite. The Phase 1 schema already supports all Phase 3 event types because (a) `event_type` is plain TEXT validated by the applier registry, (b) `target_id` is the generalized target column from day one. The Phase 3 work is in code: new applier entries for `person_added`, `person_renamed`, `person_phone_changed`, `person_archived`, `person_unarchived`, `shop_profile_updated`, `vault_setting_set`, `vault_member_added`, `vault_member_role_changed`, `vault_member_removed`, `account_bound`.

#### Phase 4 schema (migration 009)

**Migration 009 — `009_invitations`**. `projection_conflicts` has already moved up to Phase 3 migration 008 (resolves A5), so this migration adds only the pending invitations mirror.

```sql
-- Local mirror of pending invitations the user can accept
CREATE TABLE pending_invitations (
  invite_token        TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  vault_name          TEXT NOT NULL,
  inviter_email       TEXT,
  inviter_name        TEXT,
  role                TEXT NOT NULL CHECK (role IN ('editor','viewer','owner')),
  invited_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  surfaced_at         INTEGER,                  -- when shown to user
  declined_at         INTEGER
);
```

**Trust note (resolves m13):** `invite_token` is stored plaintext in SQLite, same trust level as the `session_jwt` in SecureStore. Device compromise = full account access. This is the threat model contract for a local-first app; invite tokens add no separate layer.

#### Phase 5 schema (migration 010, only if mesh ships — reclassified as post-Phase-4 hypothesis (v0.9.0 candidate))

**Migration 010 — `010_mesh_credentials`**. Note: per the founder critique and updated Decisions Log, Phase 5 is reclassified as a post-Phase-4 hypothesis (v0.9.0 candidate); this migration is only laid out for future reference.

```sql
-- Server-issued Vault Membership Credential cache
CREATE TABLE vault_credentials (
  vault_id        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL,            -- our install_id
  device_pubkey   TEXT NOT NULL,            -- ed25519 pubkey b64
  -- device_privkey REMOVED from SQLite (resolves C4 / S5).
  -- It lives in expo-secure-store under key "mesh-device-key-<install_id>".
  vmc_blob        TEXT NOT NULL,            -- the signed credential
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  vault_epoch     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, device_id)
);

-- Cached server pubkey (pinned)
-- Stored in app_meta as JSON: { "primary": "ed25519:…", "rotation": "ed25519:…" }

-- Revocation list cache
CREATE TABLE revocation_list (
  vault_id        TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  revoked_at      INTEGER NOT NULL,
  PRIMARY KEY (vault_id, device_id)
);
```

### Backend (Postgres) — by phase

#### Phase 1: no backend schema changes

Event log lives only on mobile in Phase 1. Backend mirroring arrives with Phase 3.

#### Phase 2: migration 006 — accounts + vault skeleton + vault_epoch (resolves A3)

```sql
-- 006_accounts_and_vaults.sql
CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  name            TEXT,
  picture_url     TEXT,
  locale          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at     TIMESTAMPTZ
);
CREATE INDEX idx_accounts_email ON accounts(LOWER(email));

-- Refactor auth_credentials to reference accounts
ALTER TABLE auth_credentials
  ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
-- Backfill from existing provider_sub
INSERT INTO accounts (google_sub, email, name, picture_url, last_login_at)
  SELECT provider_sub, COALESCE(email,''), name, picture_url, last_used_at
  FROM auth_credentials WHERE provider='google'
  ON CONFLICT (google_sub) DO NOTHING;
UPDATE auth_credentials ac
  SET account_id = a.id
  FROM accounts a
  WHERE ac.provider='google' AND ac.provider_sub = a.google_sub;
ALTER TABLE auth_credentials ALTER COLUMN account_id SET NOT NULL;

-- Tag installs with their account
ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS event_log_migration_observed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS vaults (
  vault_id          UUID PRIMARY KEY,
  owner_account_id  UUID NOT NULL REFERENCES accounts(id),
  name              TEXT NOT NULL,
  currency          TEXT,
  vault_epoch       BIGINT NOT NULL DEFAULT 0,   -- bumped on every membership change (resolves A3)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMPTZ,
  pending_delete_by UUID REFERENCES accounts(id),
  pending_delete_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vault_members (
  id                  BIGSERIAL PRIMARY KEY,
  vault_id            UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  account_id          UUID REFERENCES accounts(id),       -- nullable until accept
  role                TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by          UUID REFERENCES accounts(id),
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES accounts(id),
  revoked_reason      TEXT,
  invite_email        TEXT,                       -- normalized: lowercase + gmail dot-strip (resolves AU2)
  invite_token        TEXT,                       -- 256-bit base64url; capped 7d expiry (resolves M5)
  invite_expires_at   TIMESTAMPTZ,
  invite_attempts     INTEGER NOT NULL DEFAULT 0, -- accept attempt counter; auto-revoke at 20 (resolves M5)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vault_members_unique_active
    EXCLUDE (vault_id WITH =, account_id WITH =)
    WHERE (revoked_at IS NULL AND accepted_at IS NOT NULL AND account_id IS NOT NULL)
);

-- Single-active-member partial index (resolves M8): re-invite of a revoked member
-- requires the prior row to be in a revoked state; this prevents accidental dup-active rows.
CREATE UNIQUE INDEX idx_vault_members_active_unique
  ON vault_members(vault_id, account_id)
  WHERE revoked_at IS NULL AND account_id IS NOT NULL;

CREATE INDEX idx_vault_members_account_active
  ON vault_members(account_id) WHERE revoked_at IS NULL AND accepted_at IS NOT NULL;
CREATE INDEX idx_vault_members_vault_active
  ON vault_members(vault_id) WHERE revoked_at IS NULL AND accepted_at IS NOT NULL;
CREATE UNIQUE INDEX idx_vault_members_pending_email
  ON vault_members(vault_id, lower(invite_email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND invite_email IS NOT NULL;
CREATE UNIQUE INDEX idx_vault_members_token
  ON vault_members(invite_token) WHERE invite_token IS NOT NULL;

-- Vault audit log
CREATE TABLE IF NOT EXISTS vault_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES accounts(id),
  kind        TEXT NOT NULL,
  target_id   UUID REFERENCES accounts(id),
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_vault_time ON vault_audit_log(vault_id, occurred_at DESC);

-- Backups gain vault_id + account_id (for cross-device lookup)
ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS vault_id   UUID REFERENCES vaults(vault_id),
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);
CREATE INDEX idx_backups_account
  ON backups(account_id, updated_at DESC) WHERE account_id IS NOT NULL;
```

#### Phase 3: migration 007 — sync event log + snapshots

```sql
-- 007_events.sql  (HLC end-to-end; per-vault server_seq; size enforcement)
CREATE TABLE IF NOT EXISTS events (
  event_id              UUID PRIMARY KEY,
  vault_id              UUID NOT NULL REFERENCES vaults(vault_id),

  -- HLC components (resolves C1) — three columns, NOT lamport + wallclock_unix_ms
  hlc_physical_ms       BIGINT NOT NULL,
  hlc_logical           BIGINT NOT NULL,
  hlc_device_id         UUID   NOT NULL,

  device_id             UUID NOT NULL,        -- == hlc_device_id; kept for join clarity
  account_id            UUID,                  -- NULLABLE (resolves S3): pre-sign-in events
                                               -- become syncable via the account_bound event
  event_type            TEXT NOT NULL,         -- underscored form; validated in Go (no DB CHECK)
  schema_version        SMALLINT NOT NULL DEFAULT 1,

  payload               JSONB NOT NULL CHECK (pg_column_size(payload) < 65536),  -- 64 KiB (resolves M3)

  server_received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  server_seq            BIGINT NOT NULL,       -- PER-VAULT (resolves C2), NOT BIGSERIAL
                                               -- Assigned in transaction: COALESCE(MAX, 0) + 1
                                               -- under SELECT FOR UPDATE on the vaults row.
  redacted_at           TIMESTAMPTZ,
  redacted_reason       TEXT,

  UNIQUE (vault_id, server_seq)
);

CREATE INDEX idx_events_vault_seq
  ON events(vault_id, server_seq);
CREATE INDEX idx_events_vault_device_hlc
  ON events(vault_id, device_id, hlc_physical_ms, hlc_logical);
CREATE INDEX idx_events_vault_recv_at
  ON events(vault_id, server_received_at DESC);
CREATE INDEX idx_events_redacted
  ON events(vault_id) WHERE redacted_at IS NULL;

CREATE TABLE IF NOT EXISTS vault_snapshots (
  vault_id          UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  up_to_server_seq  BIGINT NOT NULL,
  snapshot          JSONB NOT NULL CHECK (pg_column_size(snapshot) < 52428800),  -- 50 MiB cap (resolves M3)
  schema_version    SMALLINT NOT NULL,
  byte_size         INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vault_id, up_to_server_seq)
);
CREATE INDEX idx_snapshots_vault_recent
  ON vault_snapshots(vault_id, up_to_server_seq DESC);
```

#### Phase 5: migration 008 — mesh credentials

```sql
-- 008_mesh_credentials.sql (only if Phase 5 ships)
CREATE TABLE IF NOT EXISTS device_keys (
  install_id      UUID PRIMARY KEY REFERENCES installs(install_id),
  ed25519_pubkey  BYTEA NOT NULL,            -- raw 32 bytes
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_credentials_issued (
  id              BIGSERIAL PRIMARY KEY,
  vault_id        UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  install_id      UUID NOT NULL REFERENCES installs(install_id),
  role            TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  vault_epoch     BIGINT NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_vmc_vault_epoch
  ON vault_credentials_issued(vault_id, vault_epoch);

-- Vault epoch (bumped on every membership change for revocation freshness)
ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS vault_epoch BIGINT NOT NULL DEFAULT 0;
```

---

## Phases

### Phase 1 — Event Source Foundation

**Goal:** Refactor `entries` into an append-only event log with HLC timestamps. No new feature, no visible UI change. Foundation for everything else.

**Scope (in / out / deferred):**

- **In:**
  - New `event_log` table on mobile (migration 005).
  - HLC implementation (`apps/mobile/lib/hlc.ts`) — `tickLocal()`, `tickReceive()`, persisted to `app_meta.hlc_last`.
  - Event types: `entry_created`, `entry_amended`, `entry_deleted`, `entry_settled` (last one reserved for Phase 4).
  - `appendEvent()` and per-entry replay/reduce in `apps/mobile/lib/event-log.ts`.
  - Rewrite `createEntry`, `updateEntry`, `softDeleteEntry` (`db.ts:740`, `:768`, `:795`) to append events and update the projection in the same transaction.
  - Migration 006 backfills synthetic events for existing rows.
  - UUIDv7 helper (existing `Crypto.randomUUID()` is v4 by spec).
- **Out:**
  - Networking. No server changes.
  - Vault scoping (`vault_id` arrives in Phase 2).
  - Event-sourcing of `users`, `relationships`, `shop_profile` (deferred to Phase 3 migration 009 — they mutate rarely, entries are 99% of writes).
  - Multi-vault.
- **Deferred:** see "out."

**Mobile schema migrations:** 005, 006 (see §Schema).

**Backend schema migrations:** none in Phase 1.

**API endpoints:** none added.

**Mobile UI:** none added. Entry create/edit/delete UI is unchanged; only the storage layer is rewritten.

**Code touchpoints:**

- `apps/mobile/lib/db.ts:84-414` — add `runMigration005`, `runMigration006`.
- `apps/mobile/lib/db.ts:740-799` — rewrite `createEntry`, `updateEntry`, `softDeleteEntry`.
- `apps/mobile/lib/hlc.ts` — NEW.
- `apps/mobile/lib/event-log.ts` — NEW (`appendEvent`, `applyEventToProjection`, `replayEntry`).
- `apps/mobile/lib/events.ts` — NEW (the `LedgerEvent` discriminated union from D1 §2).
- `apps/mobile/lib/uuid-v7.ts` — NEW (tiny helper).
- `apps/mobile/lib/__dev__/replay-test.ts` — NEW (rebuild-from-events test).

**Done criteria:**

- All existing UI works identically (regression bar: home swipe rail at `app/index.tsx`, person detail at `app/person/[id].tsx`, entry CRUD flows).
- `SELECT COUNT(*) FROM event_log` equals lifetime entry mutations on any test install.
- The replay-test script can wipe `entries`, rebuild from `event_log`, and produce byte-identical projection state.
- Migration 006 is idempotent (runs twice = same result).
- Crash-free rate on next check-in cohort holds flat vs v0.4.0.

**Effort estimate:** 2.5 dev weeks (~55 hrs). Migration replay and the projection-rebuild logic are the slow parts.

**Risks:**

- Migration eats data on an edge-case install (e.g., `archived_at IS NOT NULL` entries that aren't backfilled). **Mitigation:** dry-run on a copy of an installed device's DB before shipping.
- Performance regression on entry insert (now 2 writes instead of 1). **Mitigation:** batch in transaction, measure on a 1000-entry fixture.
- Heisenbug: HLC `tickLocal` race when the user creates two entries in the same millisecond. **Mitigation:** persist HLC after every tick (single write per event, acceptable cost).

**Validation signal:** Matee installs v0.5.0 on his own device and uses it for a few days. **Crash rate must not regress.** No user-visible change is expected — that's the whole point.

**Interruptible:** Yes. If the founder stops here, the app looks identical to v0.4.0 from the user's POV. Foundation is laid.

---

### Self-Check (between Phase 1 and Phase 2, optional)

Matee uses v0.5.0 on his own device for a few days and watches for crashes or regressions vs v0.4.0. If something breaks, fix it before starting Phase 2; otherwise continue. This is not a gating checkpoint — there are no external users to consult.

---

### Phase 2 — Vaults + Google Auth + Access Control

**Goal:** Introduce the vault as the unit of data ownership, formalize Google sign-in as a first-class identity, wire access control even though every vault has exactly one owner in this phase.

**Scope (in / out / deferred):**

- **In:**
  - Mobile migrations 007 (schema), 008 (backfill default vault).
  - Backend migration 006 (accounts, vaults, vault_members, vault_audit_log).
  - First-class Google sign-in flow (already partially shipping per `apps/mobile/app/onboarding/auth.tsx` and `apps/backend/internal/auth/`). Hardened with `email_verified` check and 5-minute `iat` window (D3 §3 gap closure).
  - Account binding on the local-self user (`users.google_sub`, `users.account_id` from migration 007).
  - Single default vault per existing install. **No multi-vault UI yet.**
  - Backend `accounts` table; refactored `auth_credentials.account_id`.
  - Soft-deleted vaults supported in schema; UI hides archived vaults but no archival action exists yet (defer to Phase 4 settings UI).
- **Out:**
  - Vault picker in header (deferred to Phase 4 — the v0 reason still applies: UI churn for single-vault users is friction without benefit).
  - Server-mediated sync (Phase 3).
  - Cloud backup using the new vault model (Phase 3 piggybacks on existing `/v1/backup/upload` until v0.5 is the floor).
  - Invitations and multi-user (Phase 4).
- **Deferred to Phase 3:** event-sourcing of `users`/`relationships`/`shop_profile`, plumbing `vault_id` through the sync push payload.
- **Deferred to Phase 4:** multi-vault UI, invite/accept flows, ownership transfer UI.

**Mobile schema migrations:** 007, 008 (see §Schema).

**Backend schema migrations:** 006 (see §Schema).

**API endpoints (new/modified):**

- `POST /v1/auth/google` — already exists at `apps/backend/internal/auth/handler.go:19`. Modified to:
  - Add `email_verified` claim check (reject if false).
  - Add 5-minute `iat` staleness check.
  - On first login (account row newly created), atomically create a default vault row with `name = google_payload.name + "'s ledger"` and insert `vault_members(role='owner', accepted_at=NOW())`.
  - Response gains `account_id`, `default_vault_id` fields.
- `POST /v1/auth/signout` — already exists. Behavior unchanged (deletes the `auth_credentials` row).

**Request/response shapes:**

```jsonc
// POST /v1/auth/google
// Request:
{
  "install_id": "uuid",
  "id_token": "google-id-token-jwt",
  "pending_vault_registration": {     // optional, for v0.5+ migrated installs
    "id": "uuid",
    "name": "Mandawi Spice",
    "created_at": 1730000000000
  }
}
// Response (200):
{
  "session_jwt": "...",
  "account_id": "uuid",
  "default_vault_id": "uuid",
  "user": { "email": "...", "name": "...", "picture_url": "..." }
}
```

**Mobile UI screens:**

- **Modified:** `apps/mobile/app/onboarding/auth.tsx` — no visual change. The "Sign in with Google" button now produces a real `account_id` and stores `session_jwt` in SecureStore (this is already mostly shipping; Phase 2 hardens it).
- **Modified:** `apps/mobile/app/account.tsx` — adds a "Different account on this phone?" `ConfirmDialog` when sign-in detects a different `google_sub` than previously bound (D3 §9). Two options: **Keep & link**, **Wipe & start fresh** (calls `resetAllLocalData()` from `db.ts:475`).
- **No new screens.**

**Code touchpoints:**

- `apps/mobile/lib/db.ts` — add `runMigration007`, `runMigration008`. New helpers: `getActiveVaultId()`, `getActiveVault()`, `setActiveVaultId(id)`.
- `apps/mobile/lib/db.ts:571-624` (`createPerson`), `:712-724` (`archivePerson`), `:801-836` (`updatePerson`), `:740-781` (entry CRUD) — every write path accepts a `vaultId` parameter (defaulted to `getActiveVaultId()`).
- `apps/mobile/lib/db.ts:626-704` (read paths) — `SELECT … FROM entries`/`relationships` gain `WHERE vault_id = ?` clause.
- `apps/mobile/lib/auth.ts` — already exists; harden the session storage and add the "different account" detection logic.
- `apps/mobile/app/_layout.tsx:164` (`ensureInstallId`) — no change; `install_id` semantics are unchanged.
- `apps/backend/internal/auth/service.go:62` — add `email_verified` + `iat` checks.
- `apps/backend/internal/auth/service.go` — extend `SignInWithGoogle` to create a default vault on first login.
- `apps/backend/internal/db/migrations/006_accounts_and_vaults.sql` — NEW.
- `apps/backend/internal/vaults/` — NEW package: `service.go` (CRUD), `handler.go` (HTTP), to be wired in Phase 4 (Phase 2 only registers the schema).

**Done criteria:**

- Fresh install: creates 1 vault on first sign-in, all data lands in it. Visually unchanged.
- Existing install: migration 008 creates 1 vault, all data backfilled. Visually unchanged.
- Sign-in with Google produces a valid JWT, persisted, retrievable on next launch. Sign-out clears it.
- Local-only user: never sees a sign-in prompt outside onboarding/account. App works 100%.
- A user who signs in with a _different_ Google account triggers the Keep/Wipe dialog rather than silently merging or wiping.
- All v0.4 backup uploads succeed (the existing backup endpoint is not yet deprecated).
- Backend tests: account upsert is idempotent; `auth_credentials` backfill populates `account_id` for all existing rows.

**Effort estimate:** 2 dev weeks (~45 hrs). Most of the work is plumbing `vault_id` through every query in `db.ts` and verifying onboarding still works for both Google and offline paths.

**Risks:**

- `vault_id` plumbing misses a query → entries leak across vaults later (silent bug). **Mitigation:** grep audit, every `SELECT … FROM (entries|relationships)` must include `WHERE vault_id = ?`. Add a runtime assert in dev builds.
- Existing users hate being re-prompted to sign in. **Mitigation:** **don't re-prompt.** Sign-in stays optional, accessible only from Account screen (already the case).
- `_old_shop_profile` rename fails if shop_profile row doesn't exist (fresh mid-onboarding install). **Mitigation:** migration 008 handles three cases: (a) no local-self at all, no migration needed; (b) local-self exists, no shop_profile, mint "My ledger"; (c) shop_profile exists, mint with its name.

**Validation signal:**

- Matee successfully signs in on his own device, the local vault is bound to his account, the migration replays cleanly on his existing data, and the app continues to look identical to v0.5.0 outside of Account.
- Zero `_old_shop_profile` rows survive migration 007 on any install (verified on Matee's device + a fresh install fixture).
- Real-user sign-in conversion rate is N/A during the build — measurable only post-Phase-3 ship.

**Interruptible:** Yes. If Matee stops here, the app looks identical to v0.5.0 plus an optional sign-in button. The Account screen displays "Sign in to enable backup (coming soon)" — fine for solo dogfooding, but **this is a safe stop point only architecturally**; the user-visible benefit doesn't land until Phase 3. Push through to Phase 3.

---

### Phase 3 — Server Backup + Single-User Multi-Device Sync

**Goal:** Signed-in users get cloud backup that survives device loss. The same Google account on a second device sees the same vault.

**Scope (in / out / deferred):**

- **In:**
  - Backend migration 007 (events + vault_snapshots).
  - Mobile migration 009 (sync_state + widened event_log).
  - Event-sourcing of `users`, `relationships`, `shop_profile` (deferred from Phase 1).
  - `POST /v1/sync/push` and `GET /v1/sync/pull` endpoints (D5 §2).
  - `GET /v1/sync/snapshot` for new-device bootstrap.
  - Mobile sync worker (`apps/mobile/lib/sync.ts`) hooked into `BackgroundCheckIn` at `apps/mobile/app/_layout.tsx:360`.
  - 5s foreground / 30s background polling.
  - Server-side snapshot generation cron (every 1000 events or 24h).
  - Restore flow: new sign-in detects existing snapshot, prompts user to restore.
  - Migration of existing `/v1/backup/*` data: on first v0.5.0 launch with an existing backup row, seed local event log with a synthetic `import_from_v04_backup` event.
- **Out:**
  - Multi-user vaults (Phase 4).
  - Mesh (Phase 5).
  - Vault picker UI (still deferred — same vault on multiple devices doesn't add a picker).
- **Deferred:** SSE upgrade path (revisit when polling >50% backend CPU).

**Mobile schema migrations:** 009 (see §Schema).

**Backend schema migrations:** 007 (see §Schema).

**API endpoints:**

- `POST /v1/sync/push`

  ```jsonc
  // Request (gzip; Authorization: Bearer <session_jwt>):
  {
    "vault_id": "uuid",
    "device_id": "install_id-uuid",
    "events": [
      {
        "event_id": "uuid",
        "hlc": { "physical_ms": 1733410500123, "logical": 0, "device_id": "uuid" },
        "event_type": "entry_created",
        "schema_version": 1,
        "payload": { "entry_id": "...", "type": "debt", "amount_afn": 500, "note": "rice" }
      }
    ]
  }
  // Response:
  {
    "accepted": ["event_id1", "event_id2"],
    "duplicates": [],
    "rejected": [
      { "event_id": "...", "reason": "insufficient_role", "current_role": "viewer", "required_role": "editor" }
    ],
    "vault_server_seq_high": 8234   // the per-vault cursor for this vault, post-push
  }
  ```

  Limits: 500 events/batch, 1 MiB compressed body (gzip), 64 KiB per payload, 16 MiB decompressed body cap (resolves M6).
  Notes: no `client_clock_hint` field (server doesn't need it; HLC is on each event). No `prev_event_id` (chain pointer dropped — see Decisions Log).

- `GET /v1/sync/pull?vault_id=<uuid>&after_server_seq=<n>&limit=<n>` (cursor naming standardized; resolves N4)

  ```jsonc
  // Response:
  {
    "vault_id": "uuid",
    "events": [
      {
        "event_id": "uuid",
        "hlc": { "physical_ms": 1733410500123, "logical": 0, "device_id": "uuid" },
        "device_id": "uuid",
        "account_id": "uuid", // effective author (resolved via account_bound events)
        "event_type": "entry_created",
        "schema_version": 1,
        "payload": {
          /* ... */
        },
        "server_seq": 8233, // per-vault
        "server_received_at": "2026-06-06T10:12:45.231Z",
      },
    ],
    "next_after_server_seq": 8234,
    "has_more": true,
    "server_time": "2026-06-06T10:12:46.000Z",
  }
  ```

  Default `limit`=200, max 1000.

- `GET /v1/sync/snapshot?vault_id=<uuid>`

  ```jsonc
  // Response (200) when snapshot exists:
  {
    "vault_id": "uuid",
    "up_to_server_seq": 8800000,
    "schema_version": 1,
    "snapshot": {
      "users": [...],
      "shop_profile": {...},
      "relationships": [...],
      "entries": [...]
    },
    "byte_size": 142331,
    "created_at": "2026-06-06T08:00:00Z"
  }
  // Response (404) when no snapshot exists: client falls back to since=0 pull.
  ```

- `POST /v1/backup/upload`, `GET /v1/backup/latest` — **kept for v0.4 compat.** Deprecated when v0.5+ is the floor.

**Mobile UI screens:**

- **Modified:** `apps/mobile/app/account.tsx` — "Backup" section becomes "Sync." Shows "Last synced 3 min ago" (or "Sign in to enable sync"), "Sync now" button, "Restore from cloud" button.
- **New:** `apps/mobile/app/onboarding/restore.tsx` — inserted between `auth` and `profile` steps when sign-in detects an existing snapshot. UI: "We found your ledger from <date>. Restore?" + Restore / Start fresh.
- **Modified:** `apps/mobile/components/AutoBackup.tsx` — renamed `AutoSync.tsx`; instead of POSTing a full snapshot, it triggers the push/pull worker.

**Code touchpoints:**

- `apps/mobile/lib/sync.ts` — NEW. Push/pull loop, conflict resolver invocation, cursor management.
- `apps/mobile/lib/projection.ts` — NEW. The `applyEventToProjection(ev)` dispatch from D7 §6, callable for both local and remote events.
- `apps/mobile/lib/restore.ts` — NEW. `restoreFromSnapshot(snapshot, events)`.
- `apps/mobile/lib/db.ts` — `createPerson`, `archivePerson`, `updatePerson`, `updateSelfProfile` etc. become event-appending (deferred work from Phase 1).
- `apps/mobile/app/_layout.tsx:360-401` (`BackgroundCheckIn`) — sync worker runs as a sibling effect after check-in.
- `apps/backend/cmd/server/main.go` — register `/v1/sync/push`, `/v1/sync/pull`, `/v1/sync/snapshot` under the protected route group.
- `apps/backend/internal/sync/` — NEW package: `handler.go`, `service.go`, `project.go` (the canonical projection function — see §Cross-Cutting), `snapshot.go`, `membership.go`.
- `apps/backend/internal/db/migrations/007_events.sql` — NEW.

**Done criteria:**

- Two devices signed in as the same Google account. Create entry on device A. Within one 5-second poll cycle on device B (foregrounded), entry appears.
- Offline edits on A: events queue in `event_log` with `server_acked_at=NULL`; reconcile when A reconnects with no data loss.
- **Pull-then-push order is enforced in sync worker tests** (resolves C1). A push that fires before a completed pull is a bug, not a race.
- **Lawful-at-authoring-time test** (resolves C1): an 8-hour offline batch is accepted entirely if all events' HLCs predate any demotion.
- **Property-based convergence tests pass on a 10k-event corpus, both Go and TS sides byte-identical** (resolves C3 / B1). Phase 3 is not Done until the corpus is checked in and both projections pass it.
- **Projection rebuild benchmark:** measured ≤2s on Pixel 4a with 10k events. If slower, per-entry checkpoint rows are added before Done (resolves C3).
- Restore flow: install fresh APK, sign into the test account, restore, see the ledger of the original device.
- Local-only users: no change in behavior.
- Backend snapshot job runs every 5 min, generates snapshots for any vault with >1000 events since last snapshot, uses an isolated 4-connection pool, has a "skip if generated within last hour" guard (resolves M1).
- v0.4 → v0.5 migration: existing `backups` row decodes into clean per-row events (NOT one mega-event; resolves C7).

**Effort estimate:** 8–12 calendar weeks (was: "4 dev weeks"). The property-based tests, dual TS+Go projection, and projection-rebuild benchmark each take 1–2 weeks. Split into safe-park milestones 3a/3b/3c per §Realistic Calendar.

**Risks:**

- **LWW surprises the user.** A and B both edit entry X's amount; the smaller `device_id` wins. **Mitigation:** surface a small "edited on device <X> at <time>" timestamp in entry detail.
- **Pull cursor desync.** Device crashes mid-apply, cursor doesn't advance, events replay. **Mitigation:** apply events idempotently (keyed by `event_id`), cursor persistence is post-commit only.
- **Backend snapshot drift.** Server projection function diverges from mobile projection function. **Mitigation:** property test that loads N random event streams, projects on both Go and TS implementations, asserts byte-equal JSON.
- **Battery drain from 5s polling.** **Mitigation:** measured on Pixel 4a (low-end target). 5280 polls/day × 80B gzipped responses = ~420 KB/day, negligible. Confirmed in D5 §6.
- **Phone-uniqueness collision on sync** — see Appendix worked example. **Mitigation:** projection-layer detection writes a `projection_conflicts` row, UI surfaces it (Phase 4 has a settings screen for resolution; Phase 3 just shows a toast and leaves the conflict for manual fix).

**Validation signal:**

- Matee uses Kaata on his own phone + test tablet (same Google account) for a week and it Just Works — entries on one device show up on the other; offline edits reconcile; restore on a freshly-wiped device recovers the ledger.
- Self-telemetry: `sync_last_success_at` advances regularly; `sync_pending_uploads` returns to 0 after each online window.

**Interruptible:** Risky to interrupt mid-phase. If the founder must stop, ship the push-only direction first (so multi-device users can at least see their other device's writes server-side via backup), then add pull later. **Don't stop in the middle of merging event sourcing into `users`/`relationships`.**

---

### Phase 4 — Multi-User Vault Sync

**Goal:** Vault owners invite other Google accounts as editors or viewers. Access control is enforced end-to-end.

**Scope (in / out / deferred):**

- **In:**
  - Mobile migration 010 (`pending_invitations`, `projection_conflicts`).
  - Backend: vault management endpoints (`POST /v1/vaults`, invite, accept, revoke, transfer-ownership, leave, delete).
  - Three-role model (owner/editor/viewer) enforced both client-side (UX) and server-side (security). Permission matrix in D4 §1.
  - Email-anchored invites with share-link token (D4 §3).
  - Web landing page at `kaata.af/i/<token>` with deep-link to mobile.
  - Vault picker UI: shop name in header is tappable, opens BottomSheet picker. "Add a shop" affordance.
  - Vault settings screen (name, currency, members, invite, archive).
  - Audit log surface (owner sees full log; editor sees own actions; viewer sees nothing).
  - Multi-owner support with last-owner protection.
  - Ownership transfer (promote-then-leave + explicit transfer API).
  - Demotion conflict handling: server rejects out-of-permission events, mobile drops them with honest toast.
  - Vault archival (soft delete, 30-day grace, then purge).
- **Out:**
  - Mesh (Phase 5).
  - Phone-OTP invites (Google-anchored only in this plan).
  - Granular per-entry ACLs.
- **Deferred:** server-side push notifications for invite acceptance / role change. (Use polling for now; SSE upgrade path.)

**Mobile schema migrations:** 010.

**Backend schema migrations:** none (vault_members already exists from Phase 2 migration 006; this phase activates the endpoints).

**API endpoints:**

- `POST /v1/vaults` — create vault (caller becomes owner).
- `GET /v1/vaults` — list vaults for the caller.
- `PATCH /v1/vaults/:vault_id` — update name/currency (owner only).
- `POST /v1/vaults/:vault_id/archive` — soft-delete (multi-owner: requires unanimity).
- `POST /v1/vaults/:vault_id/invites` — `{email, role}`, returns `{invite_url, invite_email, expires_at}`.
- `POST /v1/vaults/invites/accept` — `{token, install_id}` with JWT.
- `GET /v1/vaults/invites/pending` — pending invites for the caller (badge in profile menu).
- `POST /v1/vaults/:vault_id/members/:account_id/revoke` — owner removes member.
- `POST /v1/vaults/:vault_id/members/:account_id/role` — change role (owner only).
- `POST /v1/vaults/:vault_id/transfer-ownership` — `{to_account_id, demote_self_to: 'editor' | 'leave'}`.
- `POST /v1/vaults/:vault_id/leave` — self-remove (rejected if last owner).
- `GET /v1/vaults/:vault_id/audit-log?since=<id>&limit=<n>` — paginated audit log.

**Mobile UI screens:**

- **New:** `apps/mobile/app/vault/settings.tsx` — vault name, currency, members list, invite button, archive button.
- **New:** `apps/mobile/app/vault/members.tsx` — members list with role badges, actions.
- **New:** `apps/mobile/app/vault/invite.tsx` — modal for entering email + picking role.
- **New:** `apps/mobile/app/vault/audit-log.tsx` — paginated audit log view (owners only).
- **New:** `apps/mobile/app/invite/[token].tsx` — deep-link landing screen for invite acceptance.
- **New:** `apps/mobile/components/VaultPickerSheet.tsx` — BottomSheet triggered by tapping shop name in header.
- **Modified:** `apps/mobile/app/index.tsx` — shop name in header is `Pressable`, opens VaultPickerSheet.
- **Modified:** `apps/mobile/components/ProfileMenuSheet.tsx` — adds "X vault invitation(s)" badge row when pending invites exist.
- **Modified:** `apps/mobile/app/person/[id].tsx`, `app/person/new.tsx`, `app/entry/new.tsx`, `app/entry/[id]/edit.tsx` — gate write affordances on `useVaultRole(vault_id)`. Viewer sees "View only" chip; editor sees full UI.

**Code touchpoints:**

- `apps/mobile/lib/vault.ts` — extend with `inviteMember()`, `acceptInvite()`, `revokeMember()`, `useVaultRole(vaultId)`.
- `apps/mobile/lib/vault-roles.ts` — NEW. The static permission table mirroring D4 §1; consulted client-side and server-side.
- `apps/backend/internal/vaults/` — NEW package: full handler+service surface for the endpoints above.
- `apps/backend/internal/sync/permissions.go` — NEW. `CheckEventPermission(ctx, accountID, vaultID, eventKind) error` consulted on every push event.
- `apps/web/src/routes/invite/[token].tsx` — NEW. Web landing page that deep-links to `kaata://invite/<token>`.

**Done criteria:**

- Founder + spouse share one vault on two phones, both can add entries, owner can demote spouse to viewer and spouse can no longer save.
- Pending invite badge appears on a new sign-in even without clicking the link.
- Demotion mid-edit produces an honest "your N recent edits could not be saved" toast, not silent failure.
- Last-owner protection: sole owner cannot leave or be revoked. Multi-owner vault requires unanimous approval for archival.
- Vault picker UI ships without disturbing single-vault users (header still shows the single shop name; the picker just becomes interactive).

**Effort estimate:** 6 dev weeks (~135 hrs). Six new screens, full ACL plumbing, invitation lifecycle.

**Risks:**

- **UI complexity for low-literacy users.** The vault picker introduces a concept some users won't understand. **Mitigation:** the picker collapses to a single-vault header for users with one vault — no behavioral change.
- **Invite link leaks.** Mitigated by email-anchored acceptance (D4 §3) — the token alone isn't enough; the invitee must sign in with the matching email.
- **Offline-revocation race.** Demoted member edits offline, owner revokes, member comes online and pushes. **Mitigation:** server returns `rejected[]` with `current_role`/`required_role`, mobile drops events, surfaces honest toast with affected entries.

**Validation signal:** Matee + a friend (or two of his own devices on different Google accounts) share a vault for a week without dropping entries on the floor. Real shopkeeper validation resumes when the post-Phase-3 ship has real users.

**Interruptible:** Hard to interrupt — vault picker is in the header once shipped. If the founder must stop, ship Phase 4 in two halves: (4a) backend ACL only, owner can grant via SQL — used only by the founder for his own family test; (4b) the invite UI for end users.

---

### Phase 5 — Local Mesh

**Goal:** Two devices on the same vault can sync over local radio without internet.

**Scope (in / out / deferred):**

- **In:**
  - WebRTC over mDNS (primary), BLE→WiFi-Direct (fallback). All Android-first.
  - QR-pair bootstrap for new device joining vault.
  - Vault Membership Credentials (VMCs) — server-signed Ed25519 tokens with `(vault_id, account_id, device_id, device_pubkey, role, issued_at, expires_at, vault_epoch)`.
  - 60-day VMC lifetime, refreshed on every check-in (D6 §5).
  - Revocation list piggybacked on check-in; gossiped between peers on handshake.
  - "Shop Mode" toggle in Account screen, off by default. Foreground notification while on.
  - Anti-entropy via per-device Lamport summary swap.
  - Mobile migration 011 (`vault_credentials`, `revocation_list`).
  - Backend migration 008 (`device_keys`, `vault_credentials_issued`, `vaults.vault_epoch`).
- **Out:**
  - iOS support beyond LAN mDNS (Multipeer Connectivity is a separate workstream — D6 §4).
  - Cross-vault federation, app-to-app discovery.

**Mobile schema migrations:** 011.

**Backend schema migrations:** 008.

**API endpoints:**

- `POST /v1/devices/register-key` — `{ed25519_pubkey}` (called once per device after sign-in).
- `POST /v1/vaults/:vault_id/credential` — issue/refresh VMC for the caller's current device.
- Existing `/v1/check-in` extended with `vmc_renewal: {...}` and `revocations: [...]` fields.

**Mobile UI screens:**

- **Modified:** `apps/mobile/app/account.tsx` — adds "Sync with nearby phones (shop mode)" toggle with one-line privacy disclosure.
- **New:** `apps/mobile/app/vault/pair.tsx` — QR code display (owner side) + scanner (new device side).
- **New:** persistent foreground notification ("Kaata is syncing with nearby phones") shown while shop mode is on.

**Code touchpoints:**

- `apps/mobile/lib/mesh/` — NEW package: `discovery.ts`, `transport.ts`, `vmc.ts`, `anti-entropy.ts`.
- `apps/mobile/lib/mesh/discovery.ts` — mDNS publish/browse via `react-native-zeroconf`.
- `apps/mobile/lib/mesh/transport.ts` — WebRTC data channel via `react-native-webrtc`.
- `apps/mobile/lib/mesh/vmc.ts` — VMC verification (`@noble/ed25519`).
- `apps/mobile/lib/mesh/anti-entropy.ts` — Lamport-summary swap, delta send.
- `apps/backend/internal/mesh/` — NEW package: VMC issuance, key registration, revocation list.
- `apps/mobile/app.json` plugins: add `react-native-webrtc` config plugin, `react-native-ble-plx`, mDNS plugin if needed.

**Done criteria:**

- Two Android phones in the same shop on the same WiFi, both shop mode on, exchange a new entry within 500ms warm / 5s cold.
- Vault credential revocation: owner revokes editor offline; editor's phone comes online and the next check-in returns a revocation; mesh handshake fails.
- Battery drain ≤ 5%/hour of shop-mode operation on a Pixel 4a equivalent.
- One device goes offline, makes 20 edits, reconnects to the other device over mesh, both converge to identical state.

**Effort estimate:** 8+ dev weeks (~180 hrs). Permissions, foreground service, BLE/Direct fallback testing matrix, key management, edge cases.

**Risks:**

- **Highest of any phase.** The testing matrix is enormous. **Mitigation:** ship behind the Shop Mode toggle (off by default), so a broken mesh release affects only opt-in users.
- **Battery / Doze mode.** Android 14 foreground service rules. **Mitigation:** explicit notification, auto-off after 12h inactivity.
- **Social graph leak via mDNS.** Discussed in D6 §14. **Mitigation:** salted vault hash in TXT record; honest disclosure copy; opt-in toggle.

**Validation signal:** Real shop with two phones runs shop mode for a month with no data loss and acceptable battery (only meaningful once real users exist post-Phase-3).

**Interruptible:** Yes before starting; no once mid-implementation. **Defer indefinitely unless real users post-Phase-3 ship spontaneously ask for offline peer sync.**

---

## Migration from v0.2.4

The current shipping APK is v0.4.0; the migration story has to support v0.2.4 → v0.7.0 jumps as well as v0.4.0 → v0.7.0 (since some users may not have updated). Every migration is additive.

### Mobile (SQLite) migration chain

Existing migrations 001–004 are untouched. We add:

- **005** — event log table (with `target_id` from day one, no CHECK on `event_type`, no `supersedes_event_id`) + projection columns on `entries`.
- **006** — backfill synthetic events from existing entries (idempotent via deterministic event IDs using a small in-app UUIDv5 helper, since `expo-crypto` SDK 54 lacks v5).
- **007** — **single atomic migration** combining vaults schema, Google auth columns on `users`, `vault_id` columns on `entries`/`relationships`, `shop_profile` rebuild, AND the backfill of all of the above + `vault_id NOT NULL` enforcement via table rewrite + drop of global `users.phone_e164` UNIQUE. The prior "007 (schema) + 008 (backfill)" split is eliminated — atomicity prevents the catastrophic partial-state UX (resolves m7, C6, S6).
- **008** — `sync_state` table + `projection_conflicts` table. No `event_log` rewrite required (resolves S1, A5).
- **009** — `pending_invitations` for Phase 4.
- **010** — mesh credentials (deferred / v0.9.0 candidate).

**Migration safety invariants:**

1. **`vault_id` columns are NOT NULL after migration 007 via table rewrite** (resolves C6). "App code enforces non-null" is not enforcement; table rewrite is. The cost is one-time copy at migration time.
2. **All migrations wrapped in a single transaction per migration file.** A partial migration on crash leaves the `schema_migrations` row absent, so it re-runs cleanly next launch. Migration 007 in particular is atomic across schema + backfill + NOT NULL rewrite (resolves m7).
3. **Synthetic backfill events have deterministic IDs** (`uuid5(namespace, "${kind}:${target_id}:${hlc_physical_ms}")`). Re-running migration 006 is a no-op via `INSERT … ON CONFLICT(event_id) DO NOTHING`. Since `expo-crypto` SDK 54 does not ship UUIDv5, a 30-line inline helper is included in `lib/uuid-v5.ts`.
4. **Backfilled `entry_amended` events** carry `payload.backfill_synthetic: true`. Future audit UI can label them "edit history not preserved before v0.5."
5. **Local-only mode is preserved.** Migrations 005–009 run for every install regardless of auth state. Sync features are gated at the UI level on `account_id != null`, not by skipping migrations.
6. **Migration UX cost:** migration 007's table rewrite for `entries`/`relationships` on a 15k-row power-user DB takes ~1-2s on Pixel 4a. Show a "Updating Kaata" splash for any migration estimated >1s (resolves m3).
7. **Sync worker reactivity:** the sync worker mount is **reactive** to `useAppMeta()` `account_id` changes, not a one-shot mount condition. Sign-in mid-session starts sync; sign-out stops it. No app restart required (resolves M9).

### Backend (Postgres) migration chain

Existing 001–005 untouched. Add:

- **006** — accounts, vaults, vault_members, vault_audit_log; backfill `auth_credentials.account_id` from existing `provider_sub` rows; add `installs.account_id` (nullable).
- **007** — events + vault_snapshots.
- **008** — mesh credentials (only if Phase 5 ships).

**Backend migration safety:**

- All `IF NOT EXISTS` and additive. Existing tables (`installs`, `app_releases`, `announcements`, `web_visits`, `backups`) are not dropped or restructured.
- Existing `/v1/check-in` continues to work for all client versions forever. New optional fields on the response (`migrate_to_backend_url`, future sync hints) are ignored by old clients per JSON's forward-compat semantics.
- Existing `/v1/backup/*` endpoints kept live in parallel with `/v1/sync/*` until v0.5 is the floor (~95% of installs on v0.5+). Then deprecated.

### Migration outcomes by client version

| Client version                               | First launch behavior                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v0.4.0 (current)                             | No migration. Existing behavior. Check-in works. Backup works.                                                                                                                                                                       |
| v0.5.0 (Phase 1 ships)                       | Migrations 005, 006 run. Synthetic events backfilled. App identical to v0.4 from user POV plus new entry-history modal (the Phase 1 carrot).                                                                                         |
| v0.6.0 (Phase 2 ships)                       | Migration 007 (single atomic) runs. Default vault minted; `vault_id NOT NULL` enforced. Sign-in is functional; backup messaging visible in Account screen.                                                                           |
| v0.7.0 (Phase 3 ships)                       | Migration 008 runs. Sync push/pull active for signed-in users. Existing `backups` row decoded into individual `entry_created`/`person_added`/`shop_profile_updated` events with derived HLCs (NOT a single mega-event; resolves C7). |
| v0.8.0 (Phase 4 ships)                       | Migration 009 runs. Multi-vault UI activates. Vault picker becomes interactive.                                                                                                                                                      |
| v0.9.0 candidate (formerly Phase 5 / "v2.0") | Migration 010 runs only if mesh hypothesis is validated. Shop Mode toggle appears in Account.                                                                                                                                        |

### Local-only mode invariants (verified at every phase boundary)

A code-review checklist item is added to every PR: "Does this feature work for a user who never signs in?" Verified:

- Migrations 005–009 run regardless of auth state.
- `event_log` is appended for every local mutation, even pre-auth. `server_acked_at` stays NULL forever; no read path checks `server_acked_at`. When the user later signs in, an `account_bound` event retroactively binds these to the new `account_id` for sync (resolves S3/A5).
- All read paths (`listPeople`, `getPerson`, `listEntries`, balance computation) continue to query projection tables exactly as today.
- `BackgroundCheckIn` (`_layout.tsx:360`) runs for everyone; the sync worker is **reactively mounted** when `account_id` transitions from null to non-null and unmounted on sign-out (resolves M9).
- WhatsApp share, settings, language picker, currency picker, country picker all work without auth.
- **Protected screens invariant (resolves AU1):** screens on the path between launch and entry-create may NOT show a sign-in CTA — specifically `index.tsx`, `person/[id].tsx`, `entry/new.tsx`, `entry/[id]/edit.tsx`. `account.tsx`, `settings.tsx`, and onboarding may show sign-in nudges.
- **LTR direction invariant (resolves m14):** Every Phase 4 new screen (`vault/settings.tsx`, `vault/members.tsx`, `vault/invite.tsx`, `vault/audit-log.tsx`, `invite/[token].tsx`, `VaultPickerSheet.tsx`) is reviewed against the LTR-direction invariant from CLAUDE.md. Semantic-direction Pressables (give/receive row, add/find FAB) hardcode `right:` positioning regardless of `I18nManager.isRTL`.

### Tracking adoption

- Mobile: `app_meta.migrated_to_event_log_at` (ms epoch) — set at end of migration 006.
- Mobile: `app_meta.active_vault_id`, `app_meta.default_vault_id` — convenience pointers.
- Backend: `installs.event_log_migration_observed_at` — first check-in with `event_log_migration_completed: true` field.
- Backend: `installs.account_id` — set on first sign-in.

Adoption funnel query:

```sql
SELECT
  COUNT(*) FILTER (WHERE event_log_migration_observed_at IS NOT NULL) AS on_event_log,
  COUNT(*) FILTER (WHERE event_log_migration_observed_at IS NOT NULL AND account_id IS NULL) AS event_log_local_only,
  COUNT(*) FILTER (WHERE account_id IS NOT NULL) AS event_log_signed_in
FROM installs
WHERE last_seen_at > NOW() - INTERVAL '30 days';
```

### Force-upgrade

Existing `app_releases.min_supported_version` mechanism (CLAUDE.md §"Release / deploy flow") handles this. If a critical bug ships in v0.7.0 and is fixed in v0.7.1:

```sql
INSERT INTO app_releases (platform, version, min_supported_version, apk_url, release_notes)
VALUES ('android', '0.7.1', '0.7.1', 'https://kaata.af/downloads/kaata-0.7.1.apk',
        'Critical sync fix. Required update.');
```

v0.4 and earlier are not force-upgraded by this — sync bugs don't affect them. Pinning `min_supported_version` only against v0.5.x or later means v0.4 holdouts are tolerated.

---

## Cross-Cutting Concerns

### Realistic Calendar (resolves founder critique T1–T5, C1–C4)

The earlier "14–18 calendar weeks to end of Phase 3" headline was a dev-week count, not calendar time. Honest converted estimates at the founder's stated 20–25 hrs/week:

**Capacity (resolves C1):** 22 hrs/week, **all engineering**. Marketing is paused during the build; no door-knocks, no dogfooding-observation budget. Matee self-tests as a side effect of using the app. Marketing resumes post-Phase-3 ship.

At 22 dev-hrs/week, a "dev week" (~22 hrs) = 1 calendar week. Then:

| Phase                             | Original estimate     | Realistic calendar                                             | Notes                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1 — event source foundation | 2.5 dev wks           | **~3 weeks**                                                   | Property-based test framework alone is a 2-day spike; CRDT debugging time-boxed at 1 week per phase per founder critique S1                                                                                                                                                                                                          |
| Phase 2 — vaults + auth           | 2 dev wks             | **~2–3 weeks**                                                 | OAuth verification with Google should be **kicked off during Phase 2**, not Phase 3 (4–6 week Google review runs in parallel)                                                                                                                                                                                                        |
| Phase 3 — sync                    | 4 dev wks (was)       | **~5–7 calendar weeks**                                        | Was underestimated by ~2x. Split into 3a/3b/3c sub-milestones (see below)                                                                                                                                                                                                                                                            |
| **Total to end of Phase 3**       | "14–18 weeks" claimed | **~7–9 months**                                                | Realistic figure including spike weeks, debugging slack, EAS build cycles, OAuth verification waits, and life. The per-phase rows above sum to ~10–13 weeks of pure code, but solo-founder calendar drag (illness, context-switch, infra debugging, OAuth review windows) is what pushes the honest total to ~7–9 months end-to-end. |
| Phase 4 — multi-user              | 6 dev wks             | **3–4 months**                                                 | Plus an external test cohort of paid testers, otherwise indefinitely deferred                                                                                                                                                                                                                                                        |
| Phase 5 — mesh                    | "8+ dev wks"          | **Reclassified as post-Phase-4 hypothesis (v0.9.0 candidate)** | See decision below                                                                                                                                                                                                                                                                                                                   |

**Phase 3 sub-milestones (resolves M2 / founder critique on un-interruptible phases):** Phase 3 is split into 2-week safe-park milestones:

- **3a** — event-source `users` / `relationships` / `shop_profile` locally; backend events table + push endpoint; push-only sync (ships shippable, no regression).
- **3b** — pull endpoint + projection equivalence (Go = TS); ships pull but no snapshot.
- **3c** — snapshot generation + restore flow; ships full sync.

Each safe-park is a shippable APK. There are no real shopkeepers being shipped to during the build anyway; 3a/3b live only on Matee's devices until 3c is done.

**Phase 5 reclassified as post-Phase-4 hypothesis (v0.9.0 candidate):** Mesh's testing matrix (mDNS + BLE + WiFi-Direct + WebRTC + foreground service + 5-device lab) is multi-month for a founder solo. The `react-native-wifi-p2p` maintenance question alone is a hidden 3-week risk. Phase 5 is removed from the v0.7.0 scope. Library entries and schema sketch are retained for future reference (v0.9.0 candidate) only. Re-introduce only after Phase 3 ships and real users (acquired post-Phase-3) explicitly demand offline peer sync.

**Skill prerequisites (resolves C3 critique):** Each phase carries a 1-week "spike" line item for skills not yet demonstrated in the repo:

- **Phase 1 spike:** property-based testing framework selection (`fast-check` vs `jest-fast-check`) + Hermes compat check.
- **Phase 3 spike:** Postgres LISTEN/NOTIFY familiarity, JSONB indexing patterns, Go SSE adoption path.
- **Phase 4 spike:** web deep-link UX, email-anchored token verification flows.

**Recurring costs to acknowledge:**

- **EAS build minutes:** free tier (~30 builds/month) is exhausted in 2 weeks of debugging Phase 3 sync. Budget $99/month from Phase 3 onward.
- **Google OAuth verification:** unverified-app limit triggers 4-6 week Google review. **Start the verification process during Phase 2**, not Phase 3.
- **Postgres at scale:** unbounded retention is fine for 1B rows / 200 GB (Open Question 4). Document the partition trigger: "when `events` table > 100M rows, partition by vault_id MOD 256 or by month." Don't pre-build; document the trigger.

**Marketing-vs-engineering invariant:** Marketing is paused during the build. Resume when Phase 3 ships something worth showing real shopkeepers.

**Morale milestones:** the real morale lever is functional progress — a working event log, a Google-account-bound vault, a two-device sync that Just Works. Public posting is optional and only meaningful post-Phase-3 ship (when there's something a real shopkeeper would care about). Per-phase milestones, framed around what's _working_ in the app rather than what's posted:

- **Phase 1 ship:** event log is the source of truth on Matee's primary device; entry-history modal works. (Optional: write up the refactor for r/reactnative.)
- **Phase 2 ship:** Matee can sign in with Google and the local vault is now bound to a real account. (Optional: tell a few Afghan dev contacts.)
- **Phase 3 ship:** Matee's phone + test tablet share the same ledger over the cloud. Restore-from-cloud works on a wiped device. **This is the milestone worth posting publicly** — backup + sync was the #1 ask from earlier shopkeeper conversations.

**Phase 1 user-visible carrot:** Phase 1 ships entry history (an `entry/[id]/history` modal screen showing edits over time) as the user-visible value. The event log makes this trivial. This prevents the "I rebuilt the foundation" → "I see nothing on screen" morale cliff during solo construction (founder critique S3/M1).

**Phase 2 user-visible carrot:** Bundle the v0.6.0 release with the existing v0.4-style backup endpoint **plus** a "Your data is now backed up to your Google account" UI string in the Account screen. Matee sees real value at sign-in even though the underlying sync arrives in Phase 3 (founder critique M4 — eliminates the "sign-in shows coming soon" sunk-cost cliff during solo dogfooding).

### Testing strategy

**Unit tests:**

- HLC `tickLocal`/`tickReceive` against worked examples (D1 §3, D7 §5).
- The projection function (`applyEventToProjection`) per event kind.
- Phone normalization (existing in `lib/phone.ts`).

**Property-based tests** (the only thing that makes our custom CRDT defensible):

- Convergence: for any pair of event lists `(A, B)`, `merge(A, B) == merge(B, A)`. Generate N random event streams, shuffle into M orderings, assert all M projections are byte-identical.
- Idempotency: applying the same event twice produces the same projection.
- Snapshot equivalence: full replay vs snapshot+delta produce byte-identical projections.

**Integration tests:**

- Migration fixtures: `apps/mobile/__tests__/fixtures/v0_2_4_realistic.sql` and `v0_4_0_realistic.sql`. Each fixture replays migrations and asserts balance equivalence, archival preservation, soft-delete handling.
- Sync end-to-end: a Go test boots the backend in-process, runs two mobile-style clients, asserts they converge after a script of pushes and pulls.

**Manual matrix** (per release):

- Two Android phones same Google account.
- Two Android phones different Google accounts (Phase 4+).
- One Android phone offline for 24h, then reconnects.
- One iOS phone on LAN (Phase 5+, post-iOS-launch).

**Server-side projection equivalence:** the Go projection function in `apps/backend/internal/sync/project.go` and the TS projection in `apps/mobile/lib/projection.ts` must produce byte-identical output. A shared test fixture (JSON of event streams + expected JSON projection) is loaded by both test suites.

### Rollback

Because every migration is additive:

- New columns on `entries`/`relationships` (`vault_id`, projection cache) are nullable — v0.4 ignores them.
- New tables (`vaults`, `vault_members_mirror`, `event_log`, etc.) are invisible to v0.4 code.
- v0.4's queries (`SELECT … FROM entries WHERE deleted_at IS NULL`) still produce correct result sets.

**True rollback (downgrade)** is not supported via OTA. If a phase ship (e.g. v0.7.0) hits a critical bug, the path is forward-fix → patch release (v0.7.1) → force-upgrade via `min_supported_version`. There is no legitimate way to push users backward to v0.4.0. Theoretical comfort: a fresh install of v0.4.0 over the same DB would read the existing rows correctly and ignore the new ones.

**Server rollback:** if a backend deploy is bad, Dokploy rollback reverts the container. Database migrations are append-only and cannot be reverted; a backend at version N-1 running against a DB migrated to version N is safe by construction (it just doesn't use the new columns/tables).

### Observability + telemetry

Existing check-in already records:

- `usage_entries_created`, `usage_customers_added`, `usage_shares_sent` (cumulative).
- `has_onboarded`.
- `migration_001_phones_invalid_count`, `migration_001_phones_conflict_count`.

Add (added pre-Phase-1, kept for self-telemetry):

- `active_days_last_7` — counts distinct days with entry creation in the last 7 days. Useful self-telemetry to spot if Matee himself stops using the app post-Phase-1.

Add (Phase 1):

- `events_appended_lifetime` — total events in `event_log`.
- `events_unsynced` — current `synced_at IS NULL` count.

Add (Phase 3):

- `sync_last_success_at` — most recent successful pull, sent on check-in.
- `sync_last_error_kind` — categorical: `network`, `auth_expired`, `permission_rejected`, etc.
- `sync_pending_uploads` — count of events with `synced_at IS NULL`.

Add (Phase 4):

- `vault_count` — number of vaults the user is a member of.
- `vault_member_count_max` — largest member count across the user's vaults.

Add (Phase 5):

- `mesh_peers_connected_max_24h` — max concurrent mesh peers in last 24h.
- `mesh_events_received_from_peers_24h`.

**Backend dashboards:**

- Daily active installs by version.
- Sign-in conversion rate by cohort.
- % of signed-in users with sync activity in last 7 days.
- p50/p95 sync push latency.
- Backup→sync migration (% of v0.4 backups successfully imported as events).

**Logging:** structured logs in Go backend via existing `httpx.Logger` middleware. Add `vault_id` and `account_id` to log context for sync requests (helps trace cross-device convergence issues).

### Error handling patterns

Reuse the patterns at `apps/mobile/lib/api.ts:39-54` (fetch + AbortController + timeout) and `apps/mobile/lib/backup.ts:192-217` (categorical error taxonomy):

```ts
// All sync network calls follow this shape
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const res = await fetch(url, { signal: controller.signal, ... });
  clearTimeout(timer);
  if (res.status === 401) {
    await clearLocalSession();
    throw new SessionExpiredError();
  }
  if (res.status === 403) {
    // permission rejected — record in projection_conflicts
    throw new PermissionRejectedError(...);
  }
  if (!res.ok) {
    throw new SyncError(`sync_failed:${res.status}`);
  }
  return await res.json();
} catch (err) {
  if (err.name === 'AbortError') throw new SyncTimeoutError();
  throw err;
}
```

Sync worker exponential backoff: 1s, 2s, 4s, ... capped at 60s. After 60s the next regular poll interval just tries again.

Local writes never block on network. Every write goes to `event_log` immediately; sync is best-effort.

### Battery / background limits on Android

- **Polling cadence:** 5s foregrounded, 30s backgrounded.
- **Background work** is constrained by Android Doze and App Standby. Sync runs only in the foreground or during the existing `BackgroundCheckIn` window (once per cold start). No `WorkManager` job in this plan — the existing check-in pattern is enough.
- **AutoSync** (Phase 3, evolved from existing AutoBackup): 5-minute throttle, fires only on app state change to background with active session.
- **Shop Mode** (Phase 5): explicit foreground service notification, auto-off after 12h inactivity.

### Network failure handling

Reuses existing `Network.getNetworkStateAsync()` pattern from `_layout.tsx:368`. If offline:

- Pull: silent skip.
- Push: events accumulate in `event_log` with `synced_at=NULL`; next online cycle attempts.
- Backup endpoint: silent skip (same as today).

`backend_url_override` soft-migration (CLAUDE.md §"Backend URL soft-migration") must work for sync endpoints too. `apps/mobile/lib/api.ts:11` `getBackendUrl()` is the only function that resolves the base URL; all sync calls use it.

---

## Library Choices Summary

| Domain                         | Library                                     | Version        | License    | Bundle Impact  | Notes                                                    |
| ------------------------------ | ------------------------------------------- | -------------- | ---------- | -------------- | -------------------------------------------------------- |
| Mobile Google sign-in          | `@react-native-google-signin/google-signin` | ~15.x          | Apache-2.0 | ~1 MB native   | EAS dev client required (already in `app.json:35`)       |
| Mobile session storage         | `expo-secure-store`                         | ~14.x          | MIT        | bundled        | Already in use                                           |
| Mobile UUIDs                   | `Crypto.randomUUID()` (v4)                  | bundled        | MIT        | 0              | UUIDv7 was rejected (resolves C5); HLC carries causality |
| Mobile UUIDv5 helper           | inline                                      | —              | —          | <1 KB          | Migration-006 deterministic IDs only                     |
| Mobile CRDT/merge              | hand-rolled                                 | —              | —          | <10 KB         | ~500 LOC TypeScript                                      |
| Mobile mDNS (Phase 5)          | `react-native-zeroconf`                     | ~0.13          | MIT        | ~50 KB         | Android NSD wrapper                                      |
| Mobile WebRTC (Phase 5)        | `react-native-webrtc`                       | ~124           | MIT        | ~6–8 MB native | Config plugin via `@config-plugins/react-native-webrtc`  |
| Mobile BLE (Phase 5)           | `react-native-ble-plx`                      | ^3             | Apache-2.0 | ~1 MB native   | Polidea / DotIntent                                      |
| Mobile WiFi-Direct (Phase 5)   | `react-native-wifi-p2p`                     | ^3             | MIT        | ~200 KB        | **TBD:** verify maintenance at Phase 5 start             |
| Mobile Ed25519 (Phase 5)       | `@noble/ed25519`                            | latest         | MIT        | ~30 KB         | Pure JS, Hermes-safe                                     |
| Mobile QR (Phase 5)            | `expo-camera` / `expo-barcode-scanner`      | bundled SDK 54 | MIT        | 0              | Already in tree                                          |
| Backend HTTP router            | `github.com/go-chi/chi/v5`                  | v5             | MIT        | —              | Already in use                                           |
| Backend Postgres driver        | `github.com/jackc/pgx/v5`                   | v5             | MIT        | —              | Already in use                                           |
| Backend Google ID token verify | `google.golang.org/api/idtoken`             | latest         | BSD-3      | —              | Already in `auth/service.go:62`                          |
| Backend JWT signing            | `github.com/golang-jwt/jwt/v5`              | v5             | MIT        | —              | Already in use                                           |
| Backend gzip                   | `github.com/klauspost/compress/gzhttp`      | latest         | Apache-2.0 | —              | New, faster than stdlib                                  |
| Backend UUIDs                  | `github.com/google/uuid`                    | latest         | BSD-3      | —              | New                                                      |
| Backend membership cache       | `github.com/hashicorp/golang-lru/v2`        | v2             | MPL-2.0    | —              | 60s TTL, ~5 MB working set                               |
| Backend env loading            | `github.com/joho/godotenv`                  | latest         | MIT        | —              | Already in `config.go:36`                                |

**Rejected:**

- **Automerge / Yjs / Loro** — over-engineered for ~5 mutable fields; bundle cost (200–600 KB WASM) not justified.
- **Replicache** — Polyform Shield license is a no-go for self-hostable open-source spirit; server-authoritative conflicts with local-only mode invariant.
- **Firebase Auth / Auth0 / Clerk** — extra vendor, defeats solo-founder simplicity, no benefit over `@react-native-google-signin`.
- **libp2p** — too heavy for this plan; revisit if Kaata becomes a parallel network platform.
- **Redis / Kafka / NATS** — Postgres carries everything in this plan. `LISTEN/NOTIFY` is the escape hatch.

---

## Open Questions for the Founder

1. **Phone OTP timeline.** The plan defers phone OTP indefinitely. When (if ever) does Afghan SMS infrastructure become viable enough to add as a second auth provider? This affects the `auth_credentials` schema design (it's provider-agnostic today, but provider-specific quirks may demand schema bumps).

2. **Vault naming on first sign-in.** On first Google sign-in for a v0.5+ migrated install, the local default vault keeps its existing name. On a fresh sign-in with no prior data, the server-side first-login flow names the vault `"<google name>'s ledger"`. Should the user be allowed to rename it during onboarding/auth, or is "rename in vault settings later" enough? **DECIDE LATER:** depends on Phase 4 UX testing.

3. **Multi-account on one device.** Plan says no for this iteration. Confirm: if a user wants to maintain a separate vault for two shops (one personal, one business) under different Google accounts on the same phone, they have to wipe between switches. Is this acceptable? Alternative is one Google account, multi-vault (already supported in Phase 4).

4. **Snapshot retention on the server.** Plan stores all events forever and snapshots every 1000 events / 24h. Confirm we want unbounded server-side retention or set a TTL (e.g., snapshots older than 1 year archived to cold storage). For 100k vaults at 10k events/vault = 1B rows, ~200 GB. Acceptable for years.

5. **Audit log retention.** D4 says "indefinite for now" with optional 2-year cull. Confirm the indefinite policy or pick a number.

6. **Web invite landing page.** Phase 4 needs `kaata.af/i/<token>` to deep-link to mobile. **TBD:** does the web app become more than a marketing landing page in this plan? Specifically, do we need an `apps/web/src/routes/invite/[token].tsx` or does the existing static site handle this with a single page?

7. **Force-update window.** Plan keeps v0.4 functional forever. Confirm there's no business reason to force v0.4 users off (e.g., backend cost of supporting `/v1/backup/*` indefinitely).

8. **Phase 5 staffing.** Mesh testing requires a 5-device physical lab (D6 §13). Is this affordable / feasible for a solo founder? If not, Phase 5 ships behind a feature flag, opt-in only for the founder's own devices until external testers volunteer.

9. **Persian / RTL.** Outside this plan's scope, but every phase touches UI strings. Is a Phase 3.5 / Phase 4.5 Persian release on the roadmap, or is RTL deferred until after Phase 4 ships?

10. **Web client.** This plan assumes mobile-only sync clients. Will there ever be a web client (e.g., `kaata.af/app` for the desktop)? If yes, the sync protocol is designed for it (it's just JSON over HTTP), but additional projection logic and a web event-log adapter would be needed.

11. **Server snapshot generation strategy.** Plan says Go cron tick every 5 min, scan for vaults needing snapshots. **TBD:** confirm this happens in the existing `kaata-backend` container vs. a separate worker. Single-container is simpler; separate worker is more horizontally scalable.

12. **Mesh foreground notification copy.** D6 prescribes a notification while shop mode is on. What does it say? Suggest _"Kaata is syncing with nearby phones. Tap to turn off."_ — confirm before shipping.

---

## Appendix: Worked Examples

### Example 1: Concurrent entry amendment

**Setup:** Vault `V1`. Entry `E1` exists with amount=500, note="rice". Two devices, both signed in as the same Google account, both offline.

**Sequence:**

1. Device A (`device_id = "aaaa1234..."`): user edits amount to 600.
   - Local: append `entry_amended` event with HLC `(t=100_000_000, l=0, "aaaa1234...")`, payload `{changes: {amount_afn: 600}}` (delta, not full state).
   - Projection: `entries.amount_afn = 600`, `entries.current_event_id = <new event id>`.
2. Device B (`device_id = "bbbb5678..."`): user edits note to "basmati rice".
   - Local: append `entry_amended` event with HLC `(t=100_000_000, l=0, "bbbb5678...")`, payload `{changes: {note: "basmati rice"}}`.
   - Projection: `entries.note = "basmati rice"`.
3. Both come online. A pushes its event; backend assigns `server_seq=8819234`. B pushes its event; backend assigns `server_seq=8819235`.
4. A pulls (cursor was 8819233). Receives B's event.
   - HLC compare: `(t=100, l=0, "aaaa...") < (t=100, l=0, "bbbb...")` (lex). B's event is "later" in HLC order.
   - But A's projection already has `current_event_id` pointing to A's event. So A must replay E1's events in HLC order:
     - `entry_created` (original).
     - A's `entry_amended` `{amount: 600}` (HLC `..., "aaaa..."`).
     - B's `entry_amended` `{note: "basmati rice"}` (HLC `..., "bbbb..."`).
   - Final projection: `amount=600, note="basmati rice"`. Both edits survive because they touched different fields.
5. B pulls (cursor was 8819234). Receives A's event. Same replay yields same projection.

**Outcome:** Convergence. Both devices show `amount=600, note="basmati rice"`. If both had edited `amount`, HLC tiebreaker would have B's `amount` win because `"bbbb..." > "aaaa..."`.

### Example 2: Member demotion mid-edit

**Setup:** Vault `V2`. Owner Alice (`account_a`), editor Bob (`account_b`). Bob is composing a new entry on phone offline.

**Sequence:**

1. Bob's phone, offline: he taps "I gave" on Kareem, enters 200 AFN, taps Save.
   - Local: `createEntry()` checks role from `vault_members_mirror`. Mirror says `bob → editor`. Save proceeds.
   - `entry_created` event appended to `event_log` with `actor_account_id = account_b`. `synced_at = NULL`.
2. Alice, online, demotes Bob to viewer via Phase 4 endpoint `POST /v1/vaults/V2/members/account_b/role` with `{role: "viewer"}`.
   - Backend: updates `vault_members.role = 'viewer'`, appends `vault_audit_log` row.
3. Bob's phone reconnects. Sync worker runs.
   - **Pull-then-push is the only order** (enforced contract; resolves C1). Bob's phone pulls events to completion (`has_more = false`) first.
   - Pull returns the role-change event (`vault_member_role_changed{account_b, 'viewer'}`).
   - Mobile applies it: `vault_members_mirror.role = 'viewer'`.
4. Bob's phone now pushes its queued events.
   - Push includes the `entry_created` event Bob authored as editor.
   - Backend `CheckEventPermission(account_b, V2, 'entry_created', event_hlc_physical_ms)` consults the audit log for Bob's role AT the event's HLC timestamp. **If the event was authored before Alice's demotion, the server ACCEPTS it.** If the event was authored after the demotion HLC, it is **rejected** with `{event_id, reason: 'insufficient_role', current_role: 'viewer', required_role: 'editor'}`.

   This is the "lawful at time of authoring" rule (resolves C1). Without it, 8 hours of legitimate offline work would be rejected the moment Bob returned online, just because the demotion clock-passed before Bob's reconnect.

5. Mobile receives a rejection (only for genuinely post-demotion events).
   - Inserts into `projection_conflicts`: `{kind: 'event_rejected_by_server', detail_json: {event_id, vault_id, reason: 'insufficient_role'}, created_at: now}`.
   - Sets `event_log.rejected_at = now` on the original event (not `synced_at = -1`; resolves the earlier "DECIDE LATER" TBD). The unsynced-events index excludes rows where `rejected_at IS NOT NULL`, so no retry. The audit history is preserved.
   - Adjusts the projection: the rejected `entry_created` is treated as never-happened for balance purposes.
   - Shows toast: _"Your recent edit could not be saved — your role changed. View affected entries."_
6. Bob taps "View" → screen lists the rejected entry with copyable values. Bob can ask Alice to re-enter it (she's editor-promoted-back, or Bob is editor-restored). The audit log surfaces Alice's demotion as forensic context.

**Outcome:** No silent data loss; honest UX. Bob's local view briefly showed the entry (between save and sync); after sync it's gone, with explanation.

### Example 3: Offline mesh sync then online backfill

**Setup:** Vault `V3`. Two devices, both signed in as Alice's account. Both offline (no internet at the shop). Shop Mode is on, mDNS discovery active.

**Sequence:**

1. Alice on phone A: creates entry E1 (500 AFN to Ahmad).
   - Local: append `entry_created` event with HLC `(t=200_000_000, l=0, "aaaa...")`. `server_acked_at = NULL` (no internet).
2. Phone A's mDNS browser sees phone B's `_kaata-mesh._tcp.local.` advertisement.
3. WebRTC connection established. Handshake: both exchange VMCs (cached from last online check-in within 60-day window). Both verify against pinned server pubkey. Both same `vault_id`. Session established.
4. Anti-entropy: A sends "I have events up to HLC=H_A per (device_id, vault_id) pair"; B sends "I have events up to HLC=H_B." Delta exchange begins (HLC-based, no Lamport).
5. A sends E1's `entry_created` event to B via the WebRTC data channel.
6. B applies it: appends to its `event_log` with `origin='remote'`, `server_acked_at = NULL` (because B hasn't sent it to the _server_ yet, even though it received it from a peer). `server_acked_at` is a per-device-outbox flag, not a global property.
7. B's projection updates: Ahmad's balance changes on phone B within ~500ms of A's save.
8. Some time later, phone B catches WiFi (maybe Alice walks home). Sync worker runs.
9. Push: B sends all `server_acked_at = NULL` events — including E1 (which A authored). Backend dedupes by `event_id`: returns `duplicates: []` if A also pushed it, or `accepted: [E1]` if B is the first to reach the server.
10. Eventually A also reaches WiFi. Pushes E1. Backend returns `duplicates: [E1]` (already present from B). A sets `server_acked_at` on E1.
11. Both phones pull. Both `server_seq` cursors advance. No state change (both already have E1 in their projection).

**Outcome:** Bridging is emergent. The event log doesn't distinguish "events I authored" from "events I received from a peer" — both flow through the same sync push path. The server deduplicates by content-addressed `event_id`. Mesh adds a parallel transport but no new merge logic; the same Phase 1 event log and Phase 3 projection handle both server-mediated and peer-mediated arrivals.

---

## Critique Resolution Log

This section records the disposition of every finding from the three adversarial reviews (Engineering, Founder/Timeline, Architecture Coherence). Each entry lists the source, location, decision (ACCEPT / PARTIAL / REJECT), reasoning, and where the change landed in the plan.

### Engineering review

| #   | Source      | Critique                                                                                      | Decision              | Resulting change                                                                                                                                                                                                                                                                |
| --- | ----------- | --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Engineering | Pull-then-push ordering never enforced; demoted-user offline batches die                      | **ACCEPT**            | Decisions Log §"Sync transport" now mandates pull-to-completion before push; backend introduces "lawful at time of authoring" rule via `vault_audit_log` lookup at event HLC; Phase 3 done criteria adds explicit test. Example 2 rewritten.                                    |
| C2  | Engineering | `server_seq BIGSERIAL` global cursor causes gap-in-sequence under concurrent commits          | **ACCEPT**            | Decisions Log §"Sync transport" specifies per-vault `server_seq` assigned via `SELECT COALESCE(MAX, 0) + 1 FROM events WHERE vault_id = $1` under `SELECT FOR UPDATE` on the `vaults` row. Backend events schema rewritten: `(vault_id, server_seq)` UNIQUE; no more BIGSERIAL. |
| C3  | Engineering | "<2s replay" asserted without grounding; when is replay triggered?                            | **ACCEPT**            | Phase 3 done criteria adds Pixel-4a 10k-event benchmark gate; per-entry checkpoint rows added if exceeded. Replay-on-restore is the named runtime path.                                                                                                                         |
| C4  | Engineering | `device_privkey` in SQLite contradicts SecureStore comment                                    | **ACCEPT**            | Decisions Log §"`device_privkey` lives in SecureStore" resolves to SecureStore-only; column removed from migration 011 (now 010).                                                                                                                                               |
| C5  | Engineering | Hand-rolled UUIDv7 monotonicity is risky; HLC already provides ordering                       | **ACCEPT**            | UUIDv7 dropped in favor of `Crypto.randomUUID()` v4. Mobile event_log uses random B-tree inserts. HLC is the single source of causal ordering. Library table updated.                                                                                                           |
| C6  | Engineering | `vault_id` nullable + "code enforces non-null" is not enforcement                             | **ACCEPT**            | Migration 007 now does table-rewrite to make `vault_id NOT NULL` with FK to `vaults(id)` in the same atomic migration.                                                                                                                                                          |
| C7  | Engineering | v0.4 backup → events as single mega-event blows past payload limit and breaks 2nd-device pull | **ACCEPT**            | Decisions Log §"Backup unification" rewrites: v0.4 backup decodes to individual `entry_created`/`person_added`/`shop_profile_updated` events with derived HLCs. Guard: only fires if `event_log` is empty for the vault.                                                        |
| C8  | Engineering | `supersedes_event_id` has no validation, no cycle detection, OOO handling                     | **ACCEPT**            | Decisions Log §"Drop supersedes_event_id" removes the chain pointer entirely. LWW-by-HLC doesn't need it. Column removed from mobile schema.                                                                                                                                    |
| M1  | Engineering | Snapshot cron at scale can starve user-facing endpoints                                       | **ACCEPT**            | Decisions Log §"Snapshot generation isolation": separate 4-connection pool, delta replay over prior snapshot, 1-hour guard, single-container resolution for Open Q 11.                                                                                                          |
| M2  | Engineering | JWT has no expiry/refresh/revocation story                                                    | **ACCEPT**            | Decisions Log §"Token lifecycle" specifies 30-day JWT, rolling refresh via check-in, `auth_credentials.revoked_at` check in LRU, `POST /v1/auth/revoke-all-sessions` for lost-phone recovery.                                                                                   |
| M3  | Engineering | `events.payload JSONB` unbounded → 8 MB attack payloads                                       | **ACCEPT**            | Backend events schema gains `CHECK (pg_column_size(payload) < 65536)`; `vault_snapshots.snapshot` gains 50 MiB cap.                                                                                                                                                             |
| M4  | Engineering | LISTEN/NOTIFY scaling cliff misunderstood (connections, not CPU)                              | **ACCEPT**            | Decisions Log §"Sync transport" replaces the "50% CPU" trigger with concrete concurrent-user thresholds (500 → single-listener fan-out; 5000 → Redis).                                                                                                                          |
| M5  | Engineering | Invite token entropy / rate limit unspecified                                                 | **ACCEPT**            | Decisions Log §"Invite token spec": 256-bit base64url, 7-day cap, 5/hr rate limit, auto-revoke at 20 attempts. Backend `vault_members.invite_attempts` column added.                                                                                                            |
| M6  | Engineering | Backend gzip is a decompression bomb risk                                                     | **ACCEPT**            | Decisions Log §"Backend gzip decompression bomb defense" specifies `MaxDecompressedSize(16 << 20)`. API spec includes the 16 MiB cap.                                                                                                                                           |
| M7  | Engineering | GDPR-style account deletion + AI-training trust contract                                      | **ACCEPT**            | Decisions Log §"Encryption + AI training: trust contract, retention, and deletion" adds the deletion path with audit-log redaction and `payload.actor_name_at_time` denormalization.                                                                                            |
| M8  | Engineering | `vault_members` EXCLUDE allows re-invite of revoked member to dup-active                      | **ACCEPT**            | Backend schema adds partial unique index `idx_vault_members_active_unique` on `(vault_id, account_id) WHERE revoked_at IS NULL`.                                                                                                                                                |
| M9  | Engineering | Sync worker mounted as one-shot; sign-in mid-session doesn't start sync                       | **ACCEPT**            | Migration safety invariants section adds: sync worker is reactive to `useAppMeta()` `account_id` changes; no app restart needed.                                                                                                                                                |
| m1  | Engineering | Uniform random HLC tiebreaker (no "owner wins")                                               | **ACCEPT (document)** | Decisions Log §"Logical clock" documents the uniform-random tiebreaker as expected; future iteration path noted.                                                                                                                                                                |
| m2  | Engineering | `actor_user_id NOT NULL` confuses cross-device events                                         | **ACCEPT**            | Mobile schema renames the column comment to `author_user_id_local_only TEXT NOT NULL` and Glossary clarifies its device-local-only nature. Glossary added.                                                                                                                      |
| m3  | Engineering | event_log rename-and-copy is slow on power-user DB                                            | **PARTIAL**           | Rename-and-copy avoided entirely (Phase 3 migration 008 is purely additive now). For migration 007's `vault_id NOT NULL` rewrite, a splash is shown for migrations >1s (added to migration safety invariants).                                                                  |
| m4  | Engineering | `payload_json TEXT` has no `json_valid` check                                                 | **ACCEPT**            | Mobile event_log adds `CHECK (json_valid(payload_json))` and `payload_schema INTEGER NOT NULL DEFAULT 1`.                                                                                                                                                                       |
| m5  | Engineering | `react-native-wifi-p2p` is unmaintained, hidden 3-week Expo Module risk                       | **ACCEPT**            | Phase 5 reclassified as post-Phase-4 hypothesis (v0.9.0 candidate) in Decisions Log + Realistic Calendar; risk is moot until that classification changes.                                                                                                                       |
| m6  | Engineering | `@noble/ed25519` v2 needs SHA-512 injection on Hermes                                         | **ACCEPT (document)** | Library choices note; benchmarking deferred to the v0.9.0 candidate along with all of Phase 5.                                                                                                                                                                                  |
| m7  | Engineering | Migration 007/008 split risks data loss if 008 fails                                          | **ACCEPT**            | Migrations 007 and 008 merged into a single atomic migration 007 (see Phase 2 schema).                                                                                                                                                                                          |
| m8  | Engineering | `app_meta.hlc_last` storage format undeclared                                                 | **ACCEPT**            | Decisions Log §"Logical clock" specifies: `JSON.stringify({pms, l, did})`; HLC tick happens inside the same SQLite transaction as the event_log INSERT.                                                                                                                         |
| m9  | Engineering | golang-lru is MPL-2.0; inconsistent with Replicache rejection                                 | **REJECT (defend)**   | The Replicache rejection was about Polyform Shield (source-available, not OSI-approved). MPL-2.0 IS OSI-approved and widely used in OSS server stacks. Keeping golang-lru; rationale documented here. If a self-host scenario surfaces the conflict, swap to a ~30 LOC LRU.     |
| m10 | Engineering | 1B-event Postgres planner cliff                                                               | **ACCEPT (document)** | Realistic Calendar §Recurring costs notes the partition trigger ("when `events` > 100M rows, partition by vault_id MOD 256 or month").                                                                                                                                          |
| m11 | Engineering | Force-update doesn't trigger projection rebuild                                               | **ACCEPT**            | `app_meta.projection_rebuild_required` flag pattern noted in Migration safety invariants; a future patch (e.g. v0.5.1) may set it and trigger a splash rebuild.                                                                                                                 |
| m12 | Engineering | "lamport" in push but "HLC" elsewhere                                                         | **ACCEPT**            | Resolved by C1: HLC end-to-end, no separate Lamport anywhere. Push API spec rewritten with `hlc: {physical_ms, logical, device_id}` shape.                                                                                                                                      |
| m13 | Engineering | `invite_token` plaintext in SQLite                                                            | **REJECT (document)** | Inherent to local-first; documented in Phase 4 schema as part of the trust contract. No technical mitigation possible without breaking offline acceptance.                                                                                                                      |
| m14 | Engineering | New Phase 4 screens don't audit LTR invariant                                                 | **ACCEPT**            | Migration "Local-only mode invariants" section adds explicit LTR-direction invariant audit for all Phase 4 new screens.                                                                                                                                                         |

### Founder/timeline review

| #            | Source  | Critique                                                               | Decision              | Resulting change                                                                                                                                                                                                                              |
| ------------ | ------- | ---------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1           | Founder | "14–18 weeks" understates by 40-60%                                    | **ACCEPT**            | Executive Summary corrected to "7–9 months." New §Realistic Calendar at top of Cross-Cutting with capacity split, real per-phase calendar weeks, and full table.                                                                              |
| T2           | Founder | Phase 3 "4 dev weeks" is the biggest underestimate                     | **ACCEPT**            | Phase 3 effort estimate revised to "8–12 calendar weeks"; split into 3a/3b/3c safe-park milestones; dual TS+Go projection tax called out.                                                                                                     |
| T3           | Founder | Phase 4 "6 weeks" assumes skills not demonstrated + multi-device labor | **ACCEPT**            | Realistic Calendar bumps Phase 4 to "3–4 months + external test cohort or indefinite defer."                                                                                                                                                  |
| T4           | Founder | Phase 5 "8 dev weeks" is comically light                               | **ACCEPT**            | Phase 5 reclassified as post-Phase-4 hypothesis (v0.9.0 candidate). Removed from v0.7.0 scope. Schema/code kept as reference only.                                                                                                            |
| T5           | Founder | Phase 0 "1 week" ignores Afghan interview reality                      | **OBSOLETE**          | Moot — no interviews. Phase 0 deleted entirely; there are no real users to interview, only Matee + friend-installs.                                                                                                                           |
| S1           | Founder | Custom CRDT debugging is unbounded                                     | **ACCEPT**            | Realistic Calendar §"Phase 3 spike" adds the 1-week-per-phase debugging time-box. Pre-commit: if a convergence bug eats >1 week, swap to Yjs.                                                                                                 |
| S2           | Founder | Dual Go+TS projection is hidden recurring tax                          | **ACCEPT**            | Decisions Log §"Server-side projection — keep it, but understand the recurring tax" makes the cost explicit: ~1 dev day per new event type. Path to delete server-side projection documented.                                                 |
| S3           | Founder | Phase 1 ships nothing visible → morale poison                          | **ACCEPT**            | Realistic Calendar §"Phase 1 user-visible carrot" bundles entry-history UI with Phase 1 so Matee sees something concrete on his own device after the refactor.                                                                                |
| S4           | Founder | "95% on v0.5+" deprecation gate will never trigger                     | **ACCEPT**            | Decisions Log §"Backup unification with sync" replaces the threshold with a fixed date: 2026-12-01.                                                                                                                                           |
| S5           | Founder | Vault picker deferred but multi-vault data model lands in Phase 2      | **ACCEPT**            | Phase 2 must enforce "Google account has exactly one vault until Phase 4 endpoints unlock more"; covered by C5 resolution (server doesn't auto-mint vaults; client controls vault count).                                                     |
| C1 (founder) | Founder | Marketing-vs-engineering capacity unstated                             | **OBSOLETE**          | Moot — no marketing during the build. Capacity is 22 hrs/week all engineering; marketing resumes post-Phase-3 ship.                                                                                                                           |
| C2 (founder) | Founder | Three churned users haven't been called yet                            | **OBSOLETE**          | Moot — no real users. The named install_ids were Matee + friend-installs, not churned shopkeepers; there is nobody to call.                                                                                                                   |
| C3 (founder) | Founder | Skill gaps unacknowledged                                              | **ACCEPT**            | Realistic Calendar §"Skill prerequisites" adds per-phase 1-week spike line items.                                                                                                                                                             |
| C4 (founder) | Founder | EAS minutes + OAuth verification costs scale silently                  | **ACCEPT**            | Realistic Calendar §"Recurring costs to acknowledge" lists EAS, OAuth verification timing (start during Phase 2), Postgres growth.                                                                                                            |
| C5 (founder) | Founder | Phase 5 5-device test lab gap                                          | **ACCEPT**            | Phase 5 reclassified to post-Phase-4 hypothesis (v0.9.0 candidate); gating on paid lab or external cohort.                                                                                                                                    |
| M1 (founder) | Founder | 8-week silence between user-visible features                           | **ACCEPT**            | Phase 1 carrot (entry history); Phase 2 carrot (Google-account backup messaging) added in Realistic Calendar.                                                                                                                                 |
| M2 (founder) | Founder | "Interruptible" labels lie for Phases 3-5                              | **ACCEPT**            | Phase 3 split into 3a/3b/3c safe-park milestones (Realistic Calendar). Phase 4 gating on external testers. Phase 5 deferred.                                                                                                                  |
| M3 (founder) | Founder | Interview checkpoints can't actually be skipped — but will be          | **OBSOLETE**          | Moot — no interviews. There are no real users, so there is no interview gate to skip. Rigorous validation resumes post-Phase-3 ship.                                                                                                          |
| M4 (founder) | Founder | Phase 2 ships sign-in with no value → sunk-cost trap                   | **ACCEPT (reframed)** | Still valid even for solo dogfooding: Matee will sign in and see "backup coming soon" and feel the same sunk-cost gap. §"Phase 2 user-visible carrot" bundles the existing v0.4 backup endpoint with Phase 2's sign-in so the gap is bridged. |
| M5 (founder) | Founder | No public milestones                                                   | **ACCEPT (reframed)** | §"Morale milestones" reframed around functional progress, not public posting. Public posting is optional; the real morale lever is a working app on Matee's own device. Public posts become meaningful at Phase 3 ship.                       |

### Architecture coherence review

| #         | Source       | Critique                                                                   | Decision              | Resulting change                                                                                                                                                                                                                     |
| --------- | ------------ | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 (arch) | Architecture | HLC vs Lamport contradiction across mobile/backend/wire                    | **ACCEPT**            | Decisions Log §"Logical clock" explicitly commits to HLC end-to-end. Backend events table rewritten with `hlc_physical_ms`, `hlc_logical`, `hlc_device_id`. Wire format updated. No Lamport anywhere.                                |
| C2 (arch) | Architecture | `prev_event_id` / `supersedes_event_id` naming + semantic mismatch         | **ACCEPT**            | Decisions Log §"Drop supersedes_event_id" removes the chain pointer entirely. No more name confusion.                                                                                                                                |
| C3 (arch) | Architecture | `device_id` TEXT vs UUID across layers                                     | **ACCEPT**            | Glossary §"Wire format conventions" specifies install_id is UUIDv4 with canonical lowercase 36-char wire format. Non-UUID legacy installs get reported telemetry + "needs reprovisioning."                                           |
| C4 (arch) | Architecture | `entry_id` widening creates Phase 3 rework                                 | **ACCEPT**            | Mobile event_log Phase 1 schema uses `target_id` from day one. Phase 3 migration 008 no longer rewrites event_log.                                                                                                                   |
| C5 (arch) | Architecture | Default vault double-mint race                                             | **ACCEPT**            | Decisions Log §"Vault provisioning — first-login does NOT mint a server-side vault" — client is source of truth for vault identity.                                                                                                  |
| C6 (arch) | Architecture | v0.4 backup → events single-source vs many-author                          | **ACCEPT**            | Same as C7 (engineering); resolved via decoded-per-row events.                                                                                                                                                                       |
| C7 (arch) | Architecture | Phase 2/3 gap leaves shop_profile, users, relationships writing direct SQL | **ACCEPT**            | Phase 2 migration 007 flips writes for `users`/`relationships`/`shop_profile` through `appendEvent()` immediately. Documented in Phase 2 schema.                                                                                     |
| B1        | Architecture | Conflict resolution ownership undefined                                    | **ACCEPT**            | Decisions Log §"Sync Authority Model" defines the three roles (append authority, projection authorities, merge function IS the resolver). Shared corpus path.                                                                        |
| B2        | Architecture | No transport abstraction (sync vs mesh)                                    | **ACCEPT**            | Decisions Log §"Transport interface" defines `EventTransport`. `synced_at` renamed `server_acked_at` throughout (worked examples updated).                                                                                           |
| B3        | Architecture | Three caches with unclear coherence (mirror, LRU, VMC)                     | **ACCEPT (document)** | Decisions Log §"Token lifecycle" and §"Vault epoch bumps in Phase 2": role-change events carry through the event stream; backend LRU invalidated synchronously; VMCs anchor to `vault_epoch`.                                        |
| B4        | Architecture | `users.account_id` lifecycle on sign-out/restore                           | **ACCEPT**            | Decisions Log §"Pre-sign-in events" + Glossary clarifies: sign-out preserves `users.account_id` (re-sign-in is idempotent and silent if same `google_sub`); restore rewrites local user UUID, preserves `google_sub` + `account_id`. |
| B5        | Architecture | `actor_user_id` vs `actor_account_id` ambiguity                            | **ACCEPT**            | Decisions Log §"Pre-sign-in events" introduces `account_bound` event. `actor_user_id` renamed `author_user_id_local_only` with explicit "never sent over wire" comment.                                                              |
| N1        | Architecture | UUID type collision wire/mobile/backend                                    | **ACCEPT**            | Glossary §"Wire format conventions" pins the canonical format.                                                                                                                                                                       |
| N2        | Architecture | "vault" code / "shop" UI translation                                       | **ACCEPT**            | Glossary §"Wire format conventions" pins i18n key namespace to UI semantics, code identifiers to storage semantics; helper `i18n.shopLabel()` documented.                                                                            |
| N3        | Architecture | account/user/self/member glossary missing                                  | **ACCEPT**            | New §Glossary section right after Architecture Overview defines all four terms.                                                                                                                                                      |
| N4        | Architecture | Cursor naming chaos (`lamport`, `server_seq`, `next_since`, `since`)       | **ACCEPT**            | Decisions Log §"Sync transport" standardizes on `server_seq` only. Request param: `?after_server_seq=N`. Response: `next_after_server_seq`. Push has no cursor in payload. API spec updated.                                         |
| N5        | Architecture | "sync" overloaded                                                          | **PARTIAL**           | New file naming convention noted: `lib/sync/push.ts`, `lib/sync/pull.ts`, `lib/sync/scheduler.ts`, `lib/sync/cursor.ts`. UI: `SyncStatusCard.tsx`. Documented in transport interface section.                                        |
| A1        | Architecture | No `LedgerEvent` discriminated union schema                                | **ACCEPT**            | Decisions Log §"Event payload schemas" tabulates every event type's payload shape, including `entry_amended` delta-only payload.                                                                                                     |
| A2        | Architecture | No `Cursor` type, no `appendEvent` contract                                | **ACCEPT**            | Decisions Log §"Event log abstraction" defines `applyEvent(event, {origin}): {applied: boolean}` — single entry point, idempotent, transactional.                                                                                    |
| A3        | Architecture | Phase 5 VMC `vault_epoch` not bumped in Phase 4                            | **ACCEPT**            | Decisions Log §"Vault epoch bumps in Phase 2": `vault_epoch` moves into Phase 2 migration 006 and Phase 4 service bumps it on every membership mutation.                                                                             |
| A4        | Architecture | No `ProjectionState` / event-type registration abstraction                 | **ACCEPT**            | Decisions Log §"Event log abstraction" defines `ProjectionApplier<TEvent>` registry and the 4-step procedure to add an event type.                                                                                                   |
| A5        | Architecture | `projection_conflicts` table exists in Phase 4 but referenced in Phase 3   | **ACCEPT**            | Table moved up to Phase 3 migration 008.                                                                                                                                                                                             |
| AU1       | Architecture | "local-only forever" promise vs Account-screen prompts                     | **ACCEPT**            | Migration "Local-only mode invariants" section adds Protected Screens Invariant: sign-in CTAs only on `account.tsx`, `settings.tsx`, onboarding.                                                                                     |
| AU2       | Architecture | Gmail dot-collapsing breaks invite-email match                             | **ACCEPT**            | Decisions Log §"Email normalization for invites" specifies the normalization.                                                                                                                                                        |
| AU3       | Architecture | JWT scope/lifetime/refresh unclear                                         | **ACCEPT**            | Decisions Log §"Token lifecycle" specifies all three.                                                                                                                                                                                |
| AU4       | Architecture | "Different account" detection ambiguous                                    | **ACCEPT**            | Decisions Log §"'Different account' detection rule" specifies the 30-day window rule.                                                                                                                                                |
| S1        | Architecture | `event_type` CHECK constraints make evolution painful                      | **ACCEPT**            | Decisions Log §"Drop the event_type CHECK constraint" — validation moves to applier registry.                                                                                                                                        |
| S2        | Architecture | global `server_seq` cursor scaling                                         | **ACCEPT**            | Resolved by C2 (engineering): per-vault `server_seq`.                                                                                                                                                                                |
| S3        | Architecture | `events.account_id NOT NULL` blocks pre-Phase-2 event sync                 | **ACCEPT**            | Decisions Log §"Pre-sign-in events" — events table `account_id` is NULLABLE; `account_bound` retroactive event resolves.                                                                                                             |
| S4        | Architecture | Snapshot rebuild assumes all events present; redacted_at unexplained       | **PARTIAL**           | Decisions Log §"Encryption + AI training" + redaction semantics defined: redacted events become payload-tombstone, projection treats as no-op. Full GDPR redaction scope deferred to a future explicit phase.                        |
| S5        | Architecture | `device_privkey TEXT` in SQLite footgun                                    | **ACCEPT**            | Decisions Log §"`device_privkey` lives in SecureStore" — column removed.                                                                                                                                                             |
| S6        | Architecture | `phone_e164` UNIQUE fights multi-vault                                     | **ACCEPT**            | Decisions Log §"Person identity across devices" — global UNIQUE dropped in migration 007; app-layer per-vault uniqueness enforcement.                                                                                                |

### Tightly-localized issues from architecture review

- **Migration 006 deterministic IDs need UUIDv5** (mentioned). **ACCEPT** — 30-line inline helper added to library choices.
- **HLC race / persist after every tick** (mentioned). **ACCEPT** — Decisions Log §"Logical clock" — same-transaction with event_log INSERT.
- **Migration numbering check** — passes (no change).
- **Phase 4 SSE inconsistency for invite notifications** — **REJECT (defend)**: SSE for invite notifications is a single low-traffic stream type; polling for sync events is a high-frequency many-vaults stream. The asymmetry is justified by traffic shape, not inconsistent.
- **`synced_at = -1` sentinel TBD** — **ACCEPT** — Decisions Log + Example 2 — replaced with `event_log.rejected_at` column.

---

**End of plan.** Next action: begin Phase 1 implementation. No external gates remain.
