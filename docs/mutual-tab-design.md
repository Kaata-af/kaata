# Mutual tab (Kaata 2.0) — design contract

## Device-test decisions — 2026-09-24 (override the original sections below)

- Shared accounts are **app-only, signed-in**. `/t/{token}` is a private,
  generic app-install/open landing page, with no balances, customer names,
  ledger JSON, polling or browser mutations. Bills at `/v/` are unchanged.
  Session authentication is required by the tab API. Tokens are invitation /
  legacy-unbound-party recovery proofs, never ongoing read/write authority.
  Once bound, a forwarded invitation cannot claim or read another account's side.
- **Reject excludes a tally from both balances immediately**, but preserves the
  row and its rejection status in history. Pending and accepted tallies count.
  Accepting a rejected tally reinstates it. The wire/database value `disputed`
  is retained for compatibility; user-facing text is “Rejected”. A reason is
  optional so notification actions can reject in one tap. This replaces D6.
  Existing immutable bills remain unchanged; newly generated bills/exports
  exclude rejected tallies along with voided tallies.
- A single header overflow menu contains edit, link/manage and export.
  Counterparty tallies expose inline check / cross review controls; no review
  action sheet is required. Author-only voiding remains in the long-press menu.
- Push jobs identify the event kind and entry (no financial text or credentials).
  New-entry alerts provide Accept / Reject actions; review results notify the
  author explicitly. Actions recheck authenticated party authority on the server,
  reject stale entry revisions, and never interpret the push itself as authority.
  FCM/APNs configuration and a native rebuild remain required for real delivery.
- Notification permission is requested once at link/join, or on a signed-in
  foreground sweep for already-linked upgrades/restores. Never prompt from a
  background task or before a shared contact exists (supersedes D14's boot rule).


Status: **implementation contract** (2026-09-21) · Owner: Matee · Supersedes the
routing/naming parts of `docs/shared-ledger-spec.md` (which stays as prior art)
and implements `docs/phase-2-roadmap.md` "Phase 2: Mutual ledger" with the
decisions recorded in the 2026-07 design study.

A **tab** is one running account shared by two independent parties — a shopkeeper
and a counterparty who may be another Kaata user or a person with only a browser.
Both sides always see the same figures. Either side can add a tally; the other
side can **accept** or **dispute** it; the author can **void** it. Nothing is ever
edited or silently deleted.

This document is the contract between the backend, the mobile app and the web
page. Every JSON shape, table and function signature below is normative.

---

## 1. Decisions (and why)

| #   | Decision                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Server is the source of truth.** New Go module `internal/tabs`, tables `tabs` / `tab_parties` / `tab_entries`. Never `shared_*`.    | Two independent parties + a server needs no CRDT. The name `shared_ledgers` is poisoned (migrations 021/024/025/029).                                                                                                                                                                                                                                                                                                                                     |
| D2  | **The tab is NOT mirrored into the vault event log.** Mobile keeps a separate local cache (`tab_links`, `tab_entries`, `tab_outbox`). | Verified in code: a mirror event would be signed by *this* device and attributed to *this* account (attribution paints the counterparty's tally as "you"); viewer/clerk devices cannot mint it (role gate); `entry_deleted` is a sticky *hidden* tombstone so a **visible void** is impossible; mirrors enter the vault push outbox and replicate as shop-authored events. The 2026-07 study rejected the mirror for the same reasons. Read sites JOIN instead. |
| D3  | **The tab is a property of a contact.** `tab_links.relationship_id` binds a tab to one contact in one kaata. Never a second kaata.    | Users think "Ahmad's account", not "a tab". No vault-switcher exposure.                                                                                                                                                                                                                                                                                                                                                                                   |
| D4  | **Absolute direction on the wire**: `a_to_b` / `b_to_a` = *value moved from X to Y*. Each side derives its own "I gave / I received". | No "relative to me" ambiguity; both parties compute identical balances.                                                                                                                                                                                                                                                                                                                                                                                   |
| D5  | **Append-only + visible voids.** A void is a new row (`kind='void'`) that references the original; the original is shown struck.      | Dispute-proof. The list is the audit trail.                                                                                                                                                                                                                                                                                                                                                                                                               |
| D6  | **Accept / dispute are optional.** A tally counts the moment it lands (`status='pending'`). Only the *other* party can accept/dispute; only the *author* can void. | "Mandatory ack" is slower than paper; nobody would use it. Disputes are a flag the author resolves by voiding (and re-adding) — the roadmap's model.                                                                                                                                                                                                                                                                                                       |
| D7  | **Opening balance = one visible `kind='opening'` entry** authored by the creator at link time, disputable like any other.             | Never a silent history merge. The counterparty sees exactly what was carried over.                                                                                                                                                                                                                                                                                                                                                                        |
| D8  | **After linking, the contact's balance IS the tab balance.** Pre-link local entries stay visible under a collapsed "Before linking" fold and are excluded from the balance — **permanently, including after the tab is closed**. Closing FREEZES the shared period (rows stay, still counted, no longer writable); tallies added after a close are ordinary local entries that add on top. | The opening entry already carries the pre-link sum, and that stays true forever. Reverting to the bare local sum on close would do both halves of the damage at once: months of shared tallies would vanish from the contact, and a months-old number would appear on the home screen as if it were today's. |
| D9  | **Currency is fixed at creation** = the creator's kaata currency. A tab can only be linked into a kaata with the same currency.       | A mixed-currency balance is meaningless without a rate; the app never computes rates. Changing a kaata's currency is refused while it has an open tab.                                                                                                                                                                                                                                                                                                    |
| D10 | **Access = capability token per party** (SHA-256 at rest) **or** a session JWT whose account is bound to the party / is a member of the party's kaata. | Web-only party needs no account. Signed-in phones need no stored secret and recover tabs after reinstall via `GET /v1/tabs/mine`. A signed-out phone keeps its token in SQLite (lost on reinstall — documented, same as the old spec).                                                                                                                                                                                                                       |
| D11 | **The invite link IS party B's link** (`kaata.af/t/<b_token>`), not spent on join.                                                     | The WhatsApp thread stays the durable place to find it (paper culture). Forwarding risk is accepted for v1; A can **regenerate** B's link, either side can **close** the tab.                                                                                                                                                                                                                                                                              |
| D12 | **Web page = Go-templated shell + inline JS at `/t/{token}`**, exactly like the bill page, polling every 10 s. React SPA gets no `/t/` route in v1. | Per-tab WhatsApp preview needs SSR; one renderer instead of the bill's two; no CSP fight. Web live updates via polling — the web party has no JWT for the WebSocket.                                                                                                                                                                                                                                                                                         |
| D13 | **Realtime on mobile**: signed-in phones get `{"t":"tab_poke","tab_id"}` frames on the existing `/v1/sync/live` socket (subscribed under an `acct:<id>` pseudo-key); every phone also pulls on foreground, on person-screen focus and every 60 s in the foreground. | Reuses the broker; the poll is the backstop (pokes are lossy by design).                                                                                                                                                                                                                                                                                                                                                                                  |
| D14 | **Notifications = in-app review badges plus Expo remote push**, with a local pull fallback when remote delivery is disabled. | Push registration is party-authorized and renewed on foreground; transactional delivery jobs retry and check receipts. Generic remote payloads carry only a tab ID/revision. Native FCM/APNs credentials and `TAB_PUSH_ENABLED=true` are required; Expo Go skips the module. Permission is requested at link/join, never at boot. |
| D15 | **Deep link v1 = `kaata://t/<token>`** via the web page's "Open in Kaata" button (Android `intent://…S.browser_fallback_url`). App Links / Universal Links are a follow-up (§12). | Needs Play App Signing SHA-256 + AASA hosting + native rebuild; not blocking.                                                                                                                                                                                                                                                                                                                                                                                |
| D16 | **Money**: server stores `amount_minor BIGINT` (hundredths); the wire carries `amount` as a **decimal string in major units** (`"12.34"`, `"100"`). Never floats. | Matches mobile's major-unit convention (`lib/money.ts`); Go does integer arithmetic only.                                                                                                                                                                                                                                                                                                                                                                  |
| D17 | **Settlement double-log** (both parties record the same cash handover): v1 shows a warning when a tally with the same amount and opposite author lands within 24 h ("Ahmad already recorded 500 received today"). No handshake. | Cheapest honest mitigation; a handshake is a v2 question.                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 2. Vocabulary

### Integration corrections (2026-09-22)

- `GET /v1/tabs/by-token` resolves `Authorization: Tab <token>` to a full tab response; the mobile invitation starts here, without knowing a tab UUID.
- Signed-in join and bind send `Authorization: Bearer <jwt>` and `token` in the JSON body. Both proofs are required to attach an invitation to a new account. Signed-out join still uses the Tab header. An invalid body token never falls back to JWT access.
- Capability paths are redacted from backend access logs.
- JWT tab requests carry `X-Kaata-Party` from the local link, so overlapping
  kaata memberships cannot silently change which side authors a tally. The
  server still requires account/membership authority for that selected party.
- `linked_at_ms` is persisted per party and returned by `/mine`; a reinstall uses
  the original device cutoff, not the tab's creation date or the restoration time.
- Linking the same contact is serialized server-side across phones. Currency
  and editor-or-higher membership are verified before issuing a write capability.
- An optimistic mutation and its outbox operation commit atomically. Earlier
  deferred operations block later ones; a refused operation resets the persisted
  cursor for a full correction. Refused intent is retained in `tab_failed_ops`;
  refused tallies remain visible under “Not sent” without affecting the balance.

- **Tab** — the shared account. `tab_id` (uuid).
- **Party** — one of two sides, `role` `'a'` (creator) or `'b'` (invitee). Each party has a **label** (how they name *themselves*, shown to the other side) and a **capability token**.
- **Entry** — one tally on the tab. Immutable except `status` fields and the `voided_by_entry_id` pointer.
- **Direction** — `a_to_b` means value (goods or cash) moved from A to B: B now owes A more. `b_to_a` the reverse.
- **"I gave" / "I received"** — party P's view of an entry: P is the source of the direction → *I gave* (`type:'debt'` in mobile terms, balance from P's view increases); P is the target → *I received* (`'payment'`, decreases).
- **Balance from P's view** = Σ(entries where P is source) − Σ(entries where P is target), over rows with `kind IN ('entry','opening')` and `voided_by_entry_id IS NULL`. Positive = the other party owes P.
- **rev** — per-tab monotonic counter bumped on *every* change (entry insert, status change, void, party join/label, close). The client cursor. `seq` is the immutable creation order.

---

## 3. Backend

### 3.1 Migration `037_tabs.sql`

```sql
-- 037: mutual tab (Kaata 2.0, 2026-09-21). See docs/mutual-tab-design.md.
CREATE TABLE tabs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency    TEXT NOT NULL,
  rev         BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ,
  closed_by   TEXT CHECK (closed_by IN ('a','b'))
);

CREATE TABLE tab_parties (
  tab_id          UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('a','b')),
  label           TEXT NOT NULL DEFAULT '',
  token_hash      TEXT NOT NULL UNIQUE,            -- hex(sha256(token)), vaults.hashInviteToken shape
  account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
  vault_id        UUID REFERENCES vaults(vault_id) ON DELETE SET NULL,
  relationship_id UUID,                            -- mobile relationships.id (opaque here)
  install_id      UUID,                            -- last device that acted as this party (push, later)
  joined_at       TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  PRIMARY KEY (tab_id, role)
);
CREATE INDEX idx_tab_parties_account ON tab_parties(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_tab_parties_vault   ON tab_parties(vault_id)   WHERE vault_id IS NOT NULL;

CREATE TABLE tab_entries (
  id                 UUID PRIMARY KEY,             -- client-supplied (idempotency); server mints for 'opening'
  tab_id             UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  seq                BIGINT NOT NULL,
  rev                BIGINT NOT NULL,
  created_by         TEXT NOT NULL CHECK (created_by IN ('a','b')),
  direction          TEXT NOT NULL CHECK (direction IN ('a_to_b','b_to_a')),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  kind               TEXT NOT NULL DEFAULT 'entry' CHECK (kind IN ('entry','opening','void')),
  note               TEXT,
  occurred_at_ms     BIGINT NOT NULL,              -- author's date, epoch ms (render-time calendar only)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','disputed')),
  status_at_ms       BIGINT,
  dispute_reason     TEXT,
  voids_entry_id     UUID REFERENCES tab_entries(id),   -- set on kind='void' rows
  voided_by_entry_id UUID REFERENCES tab_entries(id),   -- set on the voided original
  UNIQUE (tab_id, seq)
);
CREATE INDEX idx_tab_entries_tab_rev ON tab_entries(tab_id, rev);
```

Rules:

- `seq` and `rev` are assigned inside a `ReadCommitted` tx after `SELECT rev FROM tabs WHERE id=$1 FOR UPDATE` (the sync `PushEvents` pattern). `UPDATE tabs SET rev = rev + 1 … RETURNING rev` gives the new rev; `seq` = `COALESCE(MAX(seq),0)+1`.
- `dispute_reason` ≤ 300 chars, `note` ≤ 500, `label` ≤ 80. Amount parsed from the wire string: `^\d{1,10}(\.\d{1,2})?$`, `> 0`, ≤ `9999999999.99` (mirrors `MAX_ENTRY_AMOUNT`).
- Void rows: `amount_minor` = original's amount, `direction` = the **opposite** of the original, `kind='void'`, `voids_entry_id`=original, `status='accepted'` (a void needs no review). Same tx sets `original.voided_by_entry_id`, bumps both rows' `rev`. Balance excludes both (`kind <> 'void' AND voided_by_entry_id IS NULL`).
- Voiding a `status='disputed'` entry is the dispute resolution. Voiding an already-voided entry → 409 `already_voided`. Only `created_by == caller role` may void → else 403 `not_author`.
- Accept/dispute only by the *other* party (`created_by <> caller role`) → else 403 `own_entry`. Accepting a disputed entry clears the dispute (status → accepted, reason kept NULL). Voided entries cannot be accepted/disputed → 409 `already_voided`. Opening entries follow the same rules (B can dispute A's opening).
- Idempotent append: `INSERT … ON CONFLICT (id) DO NOTHING`; on conflict return the existing row with 200 (not 201) **only if** it belongs to the same tab and author; otherwise 409 `id_taken`.
- Closed tab (`closed_at`): every write → 409 `tab_closed`; reads still work.
- Uniform 404 `tab_not_found` for: unknown token, unknown tab id, token/JWT not a party, token for a different tab than the URL. Token length guard `len ≤ 512` before hashing.

### 3.2 Party resolution (auth)

Every `/v1/tabs/*` route sits in a group with `authenticator.OptionalMiddleware()` + `httpx.RateLimitPerIP`. The handler resolves the caller's party in this order:

1. `Authorization: Tab <token>` header (OptionalMiddleware ignores non-`Bearer` prefixes → anonymous; the tabs handler reads the header itself). Party = row with `token_hash = hex(sha256(token))`. Must match the URL's `tab_id` when present.
2. Else JWT claims present: party = row for that tab where `account_id = claims.AccountID`, or, failing that, where `vault_id IN (active memberships of claims.AccountID)` (`vault_members.accepted_at IS NOT NULL AND revoked_at IS NULL`). Membership **role** gates writes: append needs `clerk`+, accept/dispute/void/close/label/regenerate need `editor`+ (`sync.RequiredRoleFor`-style rank: viewer 1 < clerk 2 < editor 3 < manager 4 < owner 5). Token callers have full party rights.
3. Else 404.

`tab_parties.last_seen_at` and `install_id` (from JWT claims) are stamped best-effort on every successful resolution (separate statement, errors logged).

`RateLimitPerAccount` must never be used here (fail-closed 500 for anonymous callers).

### 3.3 Routes (`cmd/server/main.go`)

| Method | Route                                   | Limit (per IP)              | Body → Response                                                                                   |
| ------ | --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/v1/tabs`                              | `TabCreateLimit` 60/h        | `CreateRequest` → 201 `CreateResponse`                                                             |
| GET    | `/v1/tabs/mine`                         | 600/h                       | JWT only (401 otherwise) → `MineResponse`                                                          |
| GET    | `/v1/tabs/{tab_id}?after_rev=N`         | `TabReadLimit` 3000/h        | → `TabResponse` (entries with `rev > N`)                                                           |
| POST   | `/v1/tabs/{tab_id}/join`                | 120/h                       | `JoinRequest` → 200 `TabResponse` (full)                                                           |
| POST   | `/v1/tabs/{tab_id}/bind`                | 120/h                       | token + JWT → binds `account_id`/`vault_id`/`relationship_id` → 200 `TabResponse`                  |
| POST   | `/v1/tabs/{tab_id}/label`               | 120/h                       | `{label}` → 200 `TabResponse`                                                                      |
| POST   | `/v1/tabs/{tab_id}/entries`             | `TabWriteLimit` 600/h        | `AppendRequest` → 201/200 `EntryResponse`                                                          |
| POST   | `/v1/tabs/{tab_id}/entries/{id}/accept` | 600/h                       | `{}` → 200 `EntryResponse`                                                                         |
| POST   | `/v1/tabs/{tab_id}/entries/{id}/dispute`| 600/h                       | `{reason}` → 200 `EntryResponse`                                                                   |
| POST   | `/v1/tabs/{tab_id}/entries/{id}/void`   | 600/h                       | `{}` → 201 `VoidResponse` (`{voided: Entry, void: Entry}`)                                         |
| POST   | `/v1/tabs/{tab_id}/close`               | 120/h                       | `{}` → 200 `TabResponse`                                                                           |
| POST   | `/v1/tabs/{tab_id}/regenerate-link`     | 60/h                        | party A only → 200 `{invite_url}` (rotates B's token; B's existing sessions lose access)          |
| GET    | `/t/{token}`                            | none                        | SSR HTML (§3.6). Uniform 404 page for unknown tokens.                                              |

CORS already allows `GET, POST, OPTIONS` + `Authorization` — every web-party call is GET/POST with `Authorization: Tab <token>`. Add `/v1/tabs` (+ prefix) to `admin.adminMutation`. Add the new limit constants to `httpx/ratelimit.go` in the existing const/var style.

### 3.4 Wire shapes

All timestamps are epoch **ms** integers. All amounts are decimal **strings** in major units.

```jsonc
// Entry
{
  "id": "uuid", "seq": 12, "rev": 40,
  "created_by": "a", "direction": "a_to_b",
  "amount": "1250", "kind": "entry", "note": "cement",
  "occurred_at_ms": 1780000000000, "created_at_ms": 1780000000123,
  "status": "pending", "status_at_ms": null, "dispute_reason": null,
  "voids_entry_id": null, "voided_by_entry_id": null
}

// Tab (meta)
{
  "id": "uuid", "currency": "AFN", "rev": 40,
  "created_at_ms": 1780000000000, "closed_at_ms": null, "closed_by": null,
  "you": "a",
  "parties": {
    "a": { "label": "Matee (Saafi Store)", "joined_at_ms": 1780000000000, "bound": true },
    "b": { "label": "", "joined_at_ms": null, "bound": false }
  },
  "balance": { "a": "1250", "b": "-1250" },     // from each party's view; signed strings, "0" when settled
  "pending_for_you": 0                            // entries by the other party with status='pending' and not voided
}

// CreateRequest (POST /v1/tabs) — creator becomes party 'a'
{
  "currency": "AFN",
  "label": "Matee (Saafi Store)",
  "vault_id": "uuid|null", "relationship_id": "uuid|null",     // stored on party a (mobile passes both)
  "opening": { "direction": "a_to_b", "amount": "3400", "note": "Balance before linking", "occurred_at_ms": 1780000000000 } | null
}
// CreateResponse
{ "tab": Tab, "entries": [Entry...], "my_token": "…", "invite_token": "…", "invite_url": "https://kaata.af/t/<invite_token>" }

// JoinRequest (POST /v1/tabs/{id}/join) — token = B's; JWT optional → binds
{ "label": "Ahmad", "vault_id": "uuid|null", "relationship_id": "uuid|null" }
// A join by a party that already joined is idempotent (label updated).
// 409 same_kaata when vault_id equals party a's vault_id.
// 409 currency_mismatch is NOT checked server-side (server doesn't know vault currency) — mobile enforces D9.

// AppendRequest (POST /v1/tabs/{id}/entries)
{ "id": "uuid", "direction": "a_to_b", "amount": "500", "note": null, "occurred_at_ms": 1780000000000 }
// EntryResponse
{ "entry": Entry, "tab": Tab, "duplicate_hint": { "entry_id": "uuid", "by": "b", "at_ms": 1780000000000 } | null }
//   duplicate_hint (D17): another non-voided entry by the OTHER party with the same amount_minor and the SAME absolute
//   direction, within ±24h of occurred_at_ms. Same direction, not opposite: B pays A 500 → A records "received" (b_to_a)
//   and B records "gave" (b_to_a); that identical pair is what doubles the balance. Opposite directions are the ordinary
//   goods-then-cash pair and net correctly. Nearest by date wins, newest breaks ties.

// TabResponse (GET /v1/tabs/{id}?after_rev=N, join, bind, label, close)
{ "tab": Tab, "entries": [Entry with rev > N, ordered by rev ASC], "full": true|false }
//   full=true when after_rev was 0/absent (client may replace its cache).

// MineResponse (GET /v1/tabs/mine)
{ "tabs": [ { "tab": Tab, "role": "a", "vault_id": "uuid|null", "relationship_id": "uuid|null" } ] }
//   Every open or closed tab where a party has account_id = me, or vault_id in my active memberships.

// Errors: httpx.ErrorCode → { "error": "...", "error_code": "tab_not_found" | "tab_closed" | "not_author" | "own_entry"
//   | "already_voided" | "id_taken" | "invalid_amount" | "invalid_direction" | "label_required" | "reason_required"
//   | "same_kaata" | "role_insufficient" | "not_party_a" | "rate_limited" }
```

### 3.5 Live pokes

- `sync.Handler.Live` subscribes each socket additionally under the pseudo-key `"acct:" + accountID`.
- `liveMsg` gains `TabID string \`json:"tab_id,omitempty"\``; the per-sub channel carries a `liveMsg` value (not a bare vault string) so the writer loop forwards `{"t":"tab_poke","tab_id":…}` unchanged. Vault pokes keep `{"t":"poke","vault_id":…}`.
- `sync.Service.NotifyTab(tabID string, accountIDs []string)` fans `tab_poke` to `acct:<id>` for each id. Exposed to `tabs` through a small interface declared in `tabs` (`type Poker interface { NotifyTab(tabID string, accountIDs []string) }`, `SetPoker`) wired in `main.go` — the `vaults.MembershipInvalidator` pattern. Call **after commit**.
- Recipients for a tab change: the `account_id` of both parties **plus** every active member account of both parties' `vault_id`s (one query).
- Mobile `lib/sync/live.ts`: `LiveChannelOpts.onTabPoke?: (tabId: string) => void`; `handleMessage` dispatches `t === "tab_poke" && tab_id`. Scheduler wires it to `lib/tabs/sync.ts` `requestTabSync(tabId)`.

### 3.6 Web page `/t/{token}`

Go-templated (`internal/tabs/templates.go`, `html/template`, `TestWriteTabPreview -preview-out` like the bill). Served on `kaata.af` via Caddy `@sharessr path /v/* /v1/shared/* /t/* /v1/tabs/*` (add both; the inline script may fetch relative or `PUBLIC_API_BASE_URL`). `Cache-Control: no-store`. `robots.txt` gets `Disallow: /t/`; `apps/web/src/lib/analytics.ts` `safeVisitPath` regex becomes `(i|v|t)`.

- Language: `acceptsPersian(Accept-Language)` picks fa/en for the shell; a small **EN / دری** toggle in the page persists to `localStorage.kaata_lang` and re-renders client-side. Calendar follows language (Jalali for fa), day-first, Afghan month names — copy the bill's inline `fmtDate`/tables. `.num` bidi isolation for amounts; `dir="auto"` on dates.
- OG: `og:title` = `"<other party label> ⇄ <your label>"` (or "Kaata tab" before join); `og:description` = balance sentence from the **link holder's** view ("You owe 1,250 AFN" / "Ahmad owes you …" / "Settled") + "Live tab on Kaata — updates as tallies are added". No og:image (matches bills).
- Body: header (labels, currency chip, "live" dot), balance hero (signed, coloured garnet/emerald by direction, mono), **Add tally** row with two buttons *I received* (left) / *I gave* (right) — same invariant as mobile — opening an inline form (amount, note, date defaulting to today), the entry list (newest first; each row: arrow tile, amount, note, date, status pill, and for the other party's pending rows **Accept** / **Dispute** buttons; for own non-voided rows a **Void** link; voided rows struck with "Voided"), "Before joining? Open in Kaata" CTA block: **Open in Kaata** (`kaata://t/<token>`; Android `intent://t/<token>#Intent;scheme=kaata;S.browser_fallback_url=<encoded https://kaata.af/download>;end`) + **Get the app** (store links from `apps/web/src/env.ts` values, hard-coded in the template).
- First visit as an unjoined B: a **join card** asking for their name (label) before anything else; POST `/join`. Stored token: the page keeps nothing — the URL is the credential (D11).
- Polling: `GET /v1/tabs/{id}?after_rev=<rev>` every 10 s while `document.visibilityState === 'visible'`, immediately on visibility change, exponential backoff to 60 s on errors. Writes are followed by an immediate pull. Optimistic UI not required.
- Print: reuse the bill's `@media print` rules (`print-color-adjust: exact`), a "Save as PDF" button.

### 3.7 Module layout

```
internal/tabs/
  service.go        // Service{pool}, Create/Mine/Get/Join/Bind/SetLabel/Append/Accept/Dispute/Void/Close/RegenerateLink, money parsing, balance
  auth.go           // resolveParty(ctx, r, tabID) — token header / JWT membership; role rank
  handler.go        // Handler{svc, webBaseURL, shareBaseURL, apiBaseURL, poker}, JSON routes, mapServiceError
  view.go           // GET /t/{token}: SSR data + OG
  templates.go      // page + 404 HTML (html/template), inline CSS/JS
  service_test.go   // real-Postgres: create/join/append/accept/dispute/void/close, seq+rev monotonic under 2 goroutines, uniform 404, idempotent append, balance vectors, duplicate_hint, role gate for JWT members
  handler_test.go   // httptest: auth resolution order, token-vs-URL mismatch 404, CORS-safe methods, rate-limit wiring smoke
  view_test.go      // TestWriteTabPreview (-preview-out), OG strings en/fa
```

Tests never point at the dev DB (`testutil.ConnectTestDB`).

---

## 4. Mobile

### 4.1 Migration `028_tabs` (`lib/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS tab_links (
  tab_id          TEXT PRIMARY KEY,
  vault_id        TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('a','b')),
  currency        TEXT NOT NULL,
  party_token     TEXT,                 -- NULL when only JWT-bound (recovered via /mine)
  my_label        TEXT NOT NULL DEFAULT '',
  other_label     TEXT NOT NULL DEFAULT '',
  other_joined_at INTEGER,
  invite_url      TEXT,                 -- party a keeps B's link for re-sharing
  rev             INTEGER NOT NULL DEFAULT 0,      -- pull cursor = highest rev applied
  closed_at       INTEGER,
  linked_at       INTEGER NOT NULL,
  last_synced_at  INTEGER,
  last_error      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tab_links_open_rel ON tab_links(relationship_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tab_links_vault ON tab_links(vault_id);

CREATE TABLE IF NOT EXISTS tab_entries (
  id                 TEXT PRIMARY KEY,
  tab_id             TEXT NOT NULL REFERENCES tab_links(tab_id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  rev                INTEGER NOT NULL,
  created_by         TEXT NOT NULL,
  direction          TEXT NOT NULL,
  amount_minor       INTEGER NOT NULL,   -- hundredths (integer), unlike entries.amount_afn
  kind               TEXT NOT NULL,
  note               TEXT,
  occurred_at        INTEGER NOT NULL,   -- ms
  created_at         INTEGER NOT NULL,   -- ms
  status             TEXT NOT NULL,
  status_at          INTEGER,
  dispute_reason     TEXT,
  voids_entry_id     TEXT,
  voided_by_entry_id TEXT,
  local_pending      INTEGER NOT NULL DEFAULT 0   -- 1 = optimistic row not yet acked by the server
);
CREATE INDEX IF NOT EXISTS idx_tab_entries_tab ON tab_entries(tab_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tab_outbox (
  id         TEXT PRIMARY KEY,            -- op id (uuid); for 'append' == the entry id
  tab_id     TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('append','accept','dispute','void','label','close')),
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER,
  last_error TEXT
);
```

Also in this migration: nothing else. Separately, `resetAllLocalData` gains `tab_links`, `tab_entries`, `tab_outbox` **and the already-missing `settlements`** in its DROP list.

### 4.2 `lib/tabs/` API surface

```ts
// lib/tabs/types.ts
export type TabRole = "a" | "b";
export type TabDirection = "a_to_b" | "b_to_a";
export type TabEntryStatus = "pending" | "accepted" | "disputed";
export type TabEntryKind = "entry" | "opening" | "void";
export type WireEntry = { id; seq; rev; created_by: TabRole; direction: TabDirection; amount: string; kind: TabEntryKind; note: string|null; occurred_at_ms; created_at_ms; status: TabEntryStatus; status_at_ms: number|null; dispute_reason: string|null; voids_entry_id: string|null; voided_by_entry_id: string|null };
export type WireTab = { id; currency; rev; created_at_ms; closed_at_ms: number|null; closed_by: TabRole|null; you: TabRole; parties: Record<TabRole, { label: string; joined_at_ms: number|null; bound: boolean }>; balance: Record<TabRole,string>; pending_for_you: number };
export type TabLink = { tab_id; vault_id; relationship_id; role: TabRole; currency; party_token: string|null; my_label; other_label; other_joined_at: number|null; invite_url: string|null; rev; closed_at: number|null; linked_at; last_synced_at: number|null; last_error: string|null };
export type TabEntryRow = { …columns of tab_entries… };
/** What EntryRow/exports need, attached to Entry as `entry.tab` */
export type TabEntryMeta = { by: "me" | "them"; status: TabEntryStatus; dispute_reason: string|null; kind: TabEntryKind; voided: boolean; local_pending: boolean; other_label: string };

// lib/tabs/direction.ts  (pure; selftest)
export function entryTypeFor(role: TabRole, direction: TabDirection): EntryType;      // 'debt' when role is the source
export function directionFor(role: TabRole, type: EntryType): TabDirection;
export function signedMinorFor(role: TabRole, e: { direction; amount_minor; kind; voided_by_entry_id }): number; // 0 for void/voided
export function tabBalanceMinor(role: TabRole, rows: Iterable<…>): number;
export function tabBalanceSql(roleExpr: string, alias?: string): string;              // SQL fragment mirroring signedMinorFor, for db.ts joins

// lib/tabs/api.ts  (network; uses getBackendUrl; auth = JWT if signed in, else `Authorization: Tab <token>`; 15 s timeout; throws TabApiError{status, code})
export class TabApiError extends Error { status: number; code: string }
export type TabAuth = { jwt: string } | { token: string };
export async function createTab(req: CreateRequest): Promise<CreateResponse>;
export async function fetchMine(): Promise<MineResponse>;                 // JWT required
export async function fetchTab(auth: TabAuth, tabId: string, afterRev: number): Promise<TabResponse>;
export async function joinTab(auth: TabAuth, tabId: string, req: JoinRequest): Promise<TabResponse>;
export async function bindTab(token: string, tabId: string, body: { vault_id; relationship_id }): Promise<TabResponse>; // token + JWT
export async function setTabLabel(auth, tabId, label): Promise<TabResponse>;
export async function appendTabEntry(auth, tabId, req: AppendRequest): Promise<EntryResponse>;
export async function acceptTabEntry(auth, tabId, entryId): Promise<EntryResponse>;
export async function disputeTabEntry(auth, tabId, entryId, reason): Promise<EntryResponse>;
export async function voidTabEntry(auth, tabId, entryId): Promise<VoidResponse>;
export async function closeTab(auth, tabId): Promise<TabResponse>;
export async function regenerateTabLink(auth, tabId): Promise<{ invite_url: string }>;
export async function resolveTabAuth(link: TabLink): Promise<TabAuth>;    // JWT wins; falls back to link.party_token; throws TabAuthUnavailableError when neither

// lib/tabs/db.ts  (SQLite; all functions take no tx and use getDb(); never inside applyEvent)
export async function getTabLinkForRelationship(relationshipId: string): Promise<TabLink | null>;   // open only
export async function getTabLinkForPerson(personId: string): Promise<TabLink | null>;                // active vault, active relationship
export async function getTabLink(tabId: string): Promise<TabLink | null>;
export async function listTabLinks(opts?: { vaultId?: string; includeClosed?: boolean }): Promise<TabLink[]>;
export async function upsertTabLink(link: TabLink): Promise<void>;
export async function upsertTabFromWire(link: Pick<TabLink,'tab_id'|'vault_id'|'relationship_id'|'party_token'|'linked_at'>, resp: TabResponse): Promise<{ newFromThem: number; statusChangedOnMine: number }>;  // applies tab meta + entries, replaces cache when full, clears local_pending rows that now exist, sets rev; emits tab + ledger refresh
export async function listTabEntriesAsEntries(link: TabLink): Promise<Entry[]>;   // mapped to Entry shape with `tab` meta, newest first; includes voided (flagged)
export async function countPendingForMe(link: TabLink): Promise<number>;
export async function insertOptimisticEntry(link: TabLink, e: { id; type: EntryType; amount: number; note; occurred_at }): Promise<void>;  // local_pending=1, seq=-1, rev=0
export async function applyOptimisticStatus(link, entryId, status, reason): Promise<void>;
export async function enqueueTabOp(op: TabOutboxRow): Promise<void>;
export async function listDueTabOps(tabId?: string): Promise<TabOutboxRow[]>;
export async function completeTabOp(id: string): Promise<void>;
export async function failTabOp(id: string, err: string, backoffMs: number): Promise<void>;
export async function listPreLinkEntries(link: TabLink): Promise<Entry[]>;       // local `entries` for the relationship with created_at <= linked_at, deleted_at IS NULL
export async function markTabClosedLocally(tabId: string, closedAt: number): Promise<void>;
export async function vaultHasOpenTab(vaultId: string): Promise<boolean>;         // for the currency-change guard

// lib/tabs/sync.ts
export async function syncTab(tabId: string): Promise<SyncTabResult>;             // flush due outbox ops for the tab (in order), then pull after_rev; coalesced per tab (in-flight + dirty), never throws (records last_error)
export async function syncAllTabs(): Promise<void>;                                // every open link, sequential, plus reconcileTabsFromServer() when signed in
export async function reconcileTabsFromServer(): Promise<void>;                    // JWT: GET /mine → upsert missing tab_links (party_token NULL), mark closed; never deletes local links
export function requestTabSync(tabId: string): void;                               // debounced (300 ms) → syncTab
export function onTabApplied(fn: (ev: { tabId; relationshipId; vaultId; newFromThem: number; statusChangedOnMine: number; origin: "pull"|"local" }) => void): () => void;
export function startTabSyncLoop(): () => void;                                    // foreground: syncAllTabs on start, on AppState active, every 60 s; background: nothing; independent of sign-in

// lib/tabs/link.ts  (the product flows; all validation here, screens stay thin)
export async function linkContact(personId: string, opts: { myLabel: string }): Promise<{ link: TabLink; inviteUrl: string }>;
//   preconditions: active vault, canAmend, no open link, vault currency known; computes pre-link balance via signedEntryMinorSumSql;
//   opening = { direction: directionFor('a', balance>0 ? 'debt' : 'payment'), amount: |balance| } or null when 0;
//   POST /v1/tabs (with vault_id+relationship_id when signed in), upsertTabLink, upsertTabFromWire, notify permission prompt (best effort)
export async function joinTabAsContact(token: string, tab: WireTab, target: { vaultId: string } & ({ personId: string } | { newPerson: { firstName; lastName: string|null; phone: string|null } }), myLabel: string): Promise<TabLink>;
//   validates vault currency === tab.currency (TabCurrencyMismatchError), rejects self-referential vault (server 409 same_kaata → TabSameKaataError), creates the person when needed via createPerson (surfacing phone_* results), POST /join (+bind when signed in), upsertTabLink+FromWire
export async function addTabEntry(personId: string, type: EntryType, amount: number, note: string|null): Promise<{ duplicateHint: EntryResponse["duplicate_hint"] }>;
//   optimistic insert + outbox + syncTab; used by entry/new when the person is linked
export async function acceptEntry(link, entryId), disputeEntry(link, entryId, reason), voidEntry(link, entryId), unlinkContact(link) /* = close */, shareTabLinkOnWhatsApp(link, person, lang): Promise<boolean>;
export async function fetchTabPreview(token: string): Promise<{ tab: WireTab; entries: WireEntry[] }>;   // for the join screen (GET with token, after_rev=0)
export function composeTabInviteMessage(lang: LocaleCode, args: { selfName; shopName: string|null; inviteUrl }): string;   // tIn(lang, 'tab.invite.message', …)
```

Errors: `TabCurrencyMismatchError`, `TabSameKaataError`, `TabAlreadyLinkedError`, `TabClosedError`, `TabAuthUnavailableError`, `TabApiError`. `entry/new`, `entry/[id]/edit`, `updateEntry`, `softDeleteEntry` refuse linked contacts with `TabLinkedEntryError` (data-layer guard in `db.ts`, like `SettledChapterError`).

### 4.3 Read-site integration (`lib/db.ts`)

- `selectAllPeopleRaw`: join the contact's tab **open or closed** — `LEFT JOIN tab_links tl ON tl.tab_id = (SELECT t2.tab_id FROM tab_links t2 WHERE t2.relationship_id = r.id ORDER BY (t2.closed_at IS NULL) DESC, t2.linked_at DESC LIMIT 1)` (the open one wins; else the newest closed one). `balance` = `CASE WHEN tl.tab_id IS NOT NULL THEN (SELECT tabBalanceSql('tl.role','te') FROM tab_entries te WHERE te.tab_id = tl.tab_id) + signedEntryMinorSumSql('e', 'e.created_at > tl.linked_at') ELSE <existing local sum> END / 100.0` — the tab's rows plus only the local tallies written AFTER the link (D8); `last_entry_at` = `MAX(local, tab)`; `last_entry_type` = type of the newest by `occurred_at` across both (derive with `entryTypeFor` in JS after the query if simpler); `is_settled` stays local-only (linked contacts are never "settled chapters"). New columns on `PersonWithBalance`: `tab_id: string | null` (set once the contact has EVER been linked), `tab_closed_at: number | null` (the only thing distinguishing a live shared account from frozen shared history — the link glyph and the chip key off it), `tab_pending: number` (entries by the other party, status pending, not voided; always 0 once closed), `tab_other_joined: 0|1`.
- `getPerson`: same shape.
- `listEntries(personId)`: if linked → `listTabEntriesAsEntries(link)` (only tab rows; the person screen shows pre-link rows via `listPreLinkEntries`). Exports (`lib/export/*`), bills (`lib/share.ts`) and the PDF builders consume `Entry[]` and must **skip** `e.tab?.voided` rows; `listEntriesForExport` (whole-kaata) UNIONs tab rows for linked contacts (non-voided) and skips pre-link local rows of linked contacts.
- `createEntry(personId, …)` → if linked, delegate to `lib/tabs/link.addTabEntry` (so `entry/new.tsx` needs no branching beyond the duplicate-hint toast).
- `getSettlementSummary` / settle-up: a contact that has EVER been linked cannot settle — `canSettle` gates on the tab history, not the open link, and `appendEntrySettled` refuses any relationship with a `tab_links` row (`TabLinkedEntryError`). Offering it on a frozen tab would mean two definitions of the balance at once: the header's (tab-aware) and the preflight's in-transaction zero check (local rows only), so a visibly-zero account would refuse every time. Chapter filtering and the settled-history toggle gate on the same condition.
- `Entry` type gains `tab?: TabEntryMeta`.
- `changeVaultCurrency` (`lib/vault-router.ts`) refuses when `vaultHasOpenTab(vaultId)` → `VaultHasOpenTabError`; settings shows `t('tab.currencyLocked')`.
- `archivePerson` on a linked contact: allowed; the tab stays open server-side and the link row stays (relationship archived). Person screen for archived people is unreachable anyway. Unlink is explicit.

### 4.4 UI

- **person/[id].tsx**
  - Header: third icon button `link-outline` (gated `canAmend`, hidden while the contact is linked). Tapping opens a BottomSheet: `Link with their kaata` → runs `linkContact` with `myLabel = self.shop_name ?? self.name`; on success opens the **share sheet**: WhatsApp (via `shareTabLinkOnWhatsApp`, respecting `getShareLangPref`/OptionSheet ask), Copy link (`expo-clipboard` if present — otherwise skip copy), and shows the link.
  - Linked state: a monochrome chip beside the direction chip: `Linked · Ahmad` (other joined) or `Link sent · waiting` (not joined). Tapping it opens a BottomSheet: `Share link again`, `Regenerate link` (party a only), `Unlink` (destructive, ConfirmDialog with description).
  - Entries card: tab rows via `EntryRow` with `tab` meta; **pre-link rows** under a collapsed fold titled `Before linking · {count}` (reuse the settled-chapter fold visual). Hide the settle row for linked contacts.
  - Long-press sheet for tab rows: mine → `Void` (destructive → ConfirmDialog); theirs (not voided) → `Accept` / `Dispute…` (dispute pushes `/tab/dispute` modal with `{personId, entryId}`); voided → no sheet. Long-press gate for tab rows uses `canAmend` (viewer/clerk cannot accept/dispute/void).
  - Ping bar unchanged (bills still work — they snapshot the tab rows).
  - `useLedgerRefresh` + `onTabApplied` both trigger `load`; a `useFocusEffect` also calls `requestTabSync(link.tab_id)`.
- **EntryRow**: new prop `tab?: TabEntryMeta`. Meta slot (≤ 20 px): pill `New` (theirs+pending), `Disputed`, `Voided`, `Sending…` (local_pending); accepted rows show nothing (calm by default). Opened row: byLine `Added by {other_label}` / `by you`; `Disputed: {reason}`; `Voided`. Voided rows: amount struck (`textDecorationLine: 'line-through'`, `textMuted`), tile at 50 % opacity. Colours stay monochrome (`bgMuted`/`textSubtle`); never emerald/garnet/danger for status.
- **PersonRow / home**: subtitle prefix `{n} to review · ` when `tab_pending > 0`; a small `link-outline` glyph (12 px, textMuted) after the name when `tab_id` is set.
- **entry/new.tsx**: unchanged flow; on success with a `duplicateHint`, `queuePendingToast(t('tab.duplicateHint', {name}), 'info')`. Errors: `TabAuthUnavailableError` → inline `t('tab.needsConnection')`.
- **entry/[id]/edit.tsx**: catches `TabLinkedEntryError` → inline `t('tab.editLocked')`.
- **app/t/[token].tsx** (deep link `kaata://t/<token>`, registered as modal): stages `loading` → `preview` (shows the other party's label, currency, balance from B's view, entry count) → `pick` (choose a kaata with matching currency — default active if it matches; then choose an existing contact via a search list like person/new, or "New contact" inline name+phone) → `joining` → done (`router.replace('/person/[id]')`). Signed-out is allowed (token access). No local self yet (fresh install) → stash `pending_tab_token` in app_meta, send to onboarding; `onboarding/success` (or wherever onboarding ends) checks the stash and `router.replace('/t/[token]')`. No kaata with matching currency → message + button to `/vault/new` (stash kept; vault/new's completion checks the stash too).
- **app/tab/dispute.tsx** (modal): reason input (required, ≤ 300), inline errors, `disputeEntry`, `queuePendingToast(t('tab.disputed'))`.
- **vault/settings.tsx**: currency row disabled with hint when `vaultHasOpenTab`.
- **i18n**: namespace `tab.*` in `en` and `fa` (Afghan Dari; `کاتا`, `دکان`, `تلفون`). Keys are listed in the implementation; every key in both tables.

### 4.5 Notifications (`lib/tabs/notify.ts`)

- At link/join, ask permission once; create Android channel `tab-updates` first.
  Lazy-load expo-notifications and skip it completely in Expo Go.
- Foreground sync renews `POST /v1/tabs/{id}/notifications` registrations hourly.
  Authentication is the same JWT/capability proof as reading that party. Empty
  token unregisters when permission is revoked. Registration is best effort and
  must never stop ledger sync.
- Server mutations enqueue alerts for the opposite party in their transaction.
  The worker rechecks authorization, retries transient errors, persists Expo
  receipt IDs, and removes DeviceNotRegistered tokens. Jobs expire after 24 hours;
  registrations expire after 30 days without renewal. Delivery is at-least-once.
- Remote payload: generic localized update text plus `{tab_id, rev}`. No labels,
  amounts, notes, invite tokens or action authority are sent to Expo/FCM/APNs.
- When remote delivery is disabled, a background pull can generate a coalesced
  local notification. This fallback cannot wake a suspended/killed app.
- Notification taps resolve the tab's local relationship, switch to its kaata,
  refresh it, then navigate to the contact. The OS notification itself never
  accepts, disputes or changes money.

### 4.6 Sync loop placement

- `TabSync` component mounted in `_layout.tsx` next to `<AutoSync/>`, unconditionally (signed-in or not); it calls `startTabSyncLoop()` and stops on unmount.
- `lib/sync/scheduler.ts`: wires `onTabPoke` → `requestTabSync`; after a successful `syncOnce` on the active vault it does **not** sync tabs (the loop does) — keep the scheduler untouched beyond the poke wiring.
- `recovery.ts` `recoverAllVaults` and `postSignInHousekeeping`: call `reconcileTabsFromServer()` best effort after vaults are restored (so a reinstalled signed-in phone gets its links back).

---

## 5. Test plan

- Go: `internal/tabs/service_test.go`, `handler_test.go`, `view_test.go` (real Postgres). Balance vectors shared with mobile: `apps/_shared/tab-vectors.json` — `[{ role, entries:[{direction, amount, kind, voided}], expected_balance }]`; Go test and `npm run selftest:tabs` both load it (like the Jalali vectors).
- Mobile: `lib/__dev__/tabs-selftest.ts` (`npm run selftest:tabs`): direction mapping both roles; `tabBalanceMinor` vs vectors; `tabBalanceSql` vs JS over an in-memory better-sqlite3? (no — keep SQL pinned by string equality + JS oracle on fixtures); outbox ordering + backoff; `upsertTabFromWire` merge logic (full vs incremental, optimistic clearing, counts) against a stub db layer.
- `npx tsc --noEmit` (mobile) and `go build ./... && go vet ./...` (backend) must pass; `bun run build` (web) unaffected.

---

## 6. Ops / follow-ups

1. **Push activation** — delivery code ships in this implementation, but credentials
   are deployment configuration, not source code. Supply Firebase client config
   through `GOOGLE_SERVICES_JSON` (EAS file variable) or ignored
   `apps/mobile/google-services.json`; configure FCM V1/APNs through EAS credentials.
   Set `TAB_PUSH_ENABLED=true` on the backend, and `EXPO_ACCESS_TOKEN` if Expo enhanced
   push security is enabled. Migrations 039 and the worker use per-tab subscriptions,
   not the install check-in table. See `kaata-2-testing.md` before enabling in production.
2. **App Links / Universal Links** — `android.intentFilters` (autoVerify, `https://kaata.af/t/`) + `/.well-known/assetlinks.json` (needs the **Play App Signing** SHA-256 from Play Console → App integrity), `ios.associatedDomains: ["applinks:kaata.af"]` + `/.well-known/apple-app-site-association` (Team ID `2JPK69B8Z2`; Caddy needs `header @aasa Content-Type application/json` inside the SPA handle). Native rebuild.
3. **Privacy/Terms + `docs/play-data-safety.md`**: disclose that a mutual tab (both parties' labels, amounts, notes) is server-held plaintext for both parties and survives either party's account deletion (`ON DELETE SET NULL`). It is NOT deleted on close — closing freezes it and both sides keep it as a read-only record (D8) — so the pages must not promise deletion. If a purge is ever wanted it needs its own decision (both parties' copies die together) and a housekeeping sweep.
4. Admin dashboard: tab counts (later).
5. Settlement handshake (D17 v2), tab-level "mark settled" ritual.
