# Shared Ledger — spec (web-first, server-backed)

Status: **draft for review** · Owner: Matee · Branch: `headless-bg-sync` (spec only; no code yet)

## 1. The problem

Two independent parties keep **one mutual running account** and need it to always
agree, without either seeing the other's private books.

Motivating case: we rent a store to a friend's dairy shop. We buy goods from him
on credit (written in *his* book); at month-end it's netted against the rent.
Today only he has the book — there's no shared, agreed record. We want both sides
to see the same tab at any time, settled cleanly with no "my number vs your
number" dispute.

This is **NOT** the existing mobile feature:

| | Shop sync (built, mobile) | Shared ledger (this spec) |
|---|---|---|
| Shares | a whole shop's book | one mutual tab between two parties |
| Visibility | everyone sees everything | each sees only the shared tab |
| Parties | one shop's devices/staff | two independent people/shops |
| Trust | one owner admits staff | two equals, symmetric |
| Storage | local-first, device-only | **server-backed** |
| Surface | mobile app | **web first** |

The privacy property we want falls out of keeping the shared tab as its **own
isolated dataset**: the only thing that ever lands on the server is the mutual
tab — never either party's full book. The mobile local-first ledger and its
"ledger data never leaves the device" rule are **untouched** by this feature.

## 2. Principles

- **Web first.** No app install required to participate. A link is enough.
- **Lean.** Reuse the existing stack (Go/chi/pgx, React 19 + react-router SPA,
  the invite-token pattern). No Next.js, no Node SSR, no new heavy deps.
- **Server is the source of truth.** Two online parties + a server means we do
  NOT need the mobile event-log/membership-chain CRDT machinery here. Plain
  append-only rows + a monotonic sequence is enough. Keep it simple.
- **Dispute-proof.** Append-only; corrections are new visible entries (voids),
  never silent edits or deletes. Every entry is attributed to who added it.
- **Shareable via WhatsApp.** Links must render a rich preview (OG tags) and a
  meaningful first paint — that's the whole point of the Go→React injection (§6).

## 3. Architecture at a glance

```
WhatsApp link  ──►  kaata.af/l/<token>
                         │
        ┌────────────────┴───────────────────┐
        │  Go backend (chi)                    │
        │  • GET /l/<token>  → SSR-lite HTML    │  serves the Vite index.html
        │    (inject boot JSON + OG meta)       │  with state baked in (§6)
        │  • /v1/l/* JSON API (create/append/…) │  Postgres (pgx)
        │  • /v1/l/<token>/events  (SSE live)   │
        └────────────────┬───────────────────┘
                         │ window.__kaata_boot__
                         ▼
        React 19 SPA (apps/web) — same Vite build, new /l/:token page.
        Reads injected state → instant render → subscribes to live updates.
```

One new backend module (`internal/sharedledger`), one migration, ~6 routes, one
React page. Mirrors the existing `/v1/vaults/invites/{token}/info` +
`/i/:token` invite pattern already in the repo.

## 4. Data model (Postgres)

New migration `apps/backend/internal/db/migrations/00X_shared_ledger.sql`.

```sql
CREATE TABLE shared_ledgers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,                       -- "Rent ⇄ Dairy"
  currency      text NOT NULL DEFAULT 'AFN',
  party_a_label text NOT NULL,                       -- creator's name for themselves
  party_b_label text,                                -- set when B claims
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);

-- One row per side. Access = possession of the capability token whose SHA-256
-- hash is stored here; the raw token lives only in the URL + the holder's
-- localStorage (mirrors how invites already work).
CREATE TABLE shared_ledger_access (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    uuid NOT NULL REFERENCES shared_ledgers(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('a','b')),
  token_hash   bytea NOT NULL UNIQUE,
  account_id   text,                                 -- optional, bound later (Phase 2 auth)
  claimed_at   timestamptz,
  last_seen_at timestamptz,
  UNIQUE (ledger_id, role)
);

-- Append-only. `direction` is ABSOLUTE (who gave value to whom), so each side
-- renders its own signed balance — no "relative to me" ambiguity.
CREATE TABLE shared_ledger_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    uuid NOT NULL REFERENCES shared_ledgers(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,                       -- per-ledger monotonic; ordering + sync cursor
  created_by   text NOT NULL CHECK (created_by IN ('a','b')),
  direction    text NOT NULL CHECK (direction IN ('a_to_b','b_to_a')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  kind         text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','cash','adjustment')),
  note         text,
  voids_entry  uuid REFERENCES shared_ledger_entries(id),  -- correction = append, never delete
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ledger_id, seq)
);
```

**Balance** (excluding voided entries), from A's perspective:
`Σ(b_to_a) − Σ(a_to_b)` = what B owes A net. B's screen shows the negation.
This is the same signed-balance idea the mobile app already uses per person —
only the storage carries the absolute direction so both sides agree.

**Money:** integer `amount_minor`. AFN has no commonly-used minor unit, so v1
stores whole AFN. Never floats.

## 5. Identity & access (lean MVP → upgrade path)

MVP = **capability links**, exactly like the existing invite flow:

1. `POST /v1/l` (public, rate-limited): A creates a ledger with a title + their
   label. Server returns `{ ledger_id, a_token, invite_token }`. A's browser
   stores `a_token` in localStorage; A shares `kaata.af/l/<invite_token>`.
2. B opens the invite link → `POST /v1/l/<invite_token>/claim` with B's label →
   server mints `b_token`, stores its hash in role `b`, returns it. B's browser
   keeps `b_token`. The invite link is now spent.
3. Thereafter each side loads `kaata.af/l/<their_token>` and can read + append.

Access is possession of an unguessable token. **Trade-off:** anyone with the
link can append, and a lost link is hard to recover. Acceptable between two
friends for an MVP; the **upgrade path** is to bind a token to an identity via
the backend's *existing* Google JWT auth (`internal/auth`) or a future phone-OTP
(already on the Phase-2 roadmap) — `shared_ledger_access.account_id` is reserved
for exactly that. Flag this clearly in the UI ("keep this link private").

## 6. The Go→React boot injection ("Next.js level, lean")

We want server-rendered data + correct link previews **without** adopting
Next.js or a Node SSR server, and **without** leaving our Vite React SPA.
Mechanism — a small Go template step over the built `index.html`:

1. `bun run build` (apps/web) → `dist/index.html` + hashed assets.
2. Backend `//go:embed` that `index.html` (and serves `/assets/*` — or the web
   host keeps serving assets; see §9 routing).
3. For `GET /l/<token>`, the Go handler:
   - validates the token, loads the ledger + entries,
   - builds a `BootState` struct → `json.Marshal`,
   - injects two things into the HTML before serving:
     - `<script id="__kaata_boot__" type="application/json">{…BootState…}</script>`
     - `<title>` + Open Graph meta (`og:title` = ledger title, `og:description`
       = "Balance: 4,200 AFN", etc.) — this is what makes the WhatsApp preview rich,
     - optionally a static summary inside `<div id="root">…</div>` for crawlers /
       no-JS (the bit React overwrites on mount).

```go
// internal/sharedledger/ssr.go (sketch)
//go:embed index.html
var indexHTML string

type BootState struct {
    Ledger  LedgerView   `json:"ledger"`
    Entries []EntryView  `json:"entries"`
    You     string       `json:"you"` // "a" | "b"
}

func (h *Handler) Page(w http.ResponseWriter, r *http.Request) {
    boot, ok := h.svc.LoadForToken(r.Context(), chi.URLParam(r, "token"))
    if !ok { http.NotFound(w, r); return } // uniform 404 — no token-existence leak
    b, _ := json.Marshal(boot)
    html := strings.Replace(indexHTML, "<!--KAATA_BOOT-->",
        `<script id="__kaata_boot__" type="application/json">`+template.JSEscapeString(string(b))+`</script>`+ogMeta(boot), 1)
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    _, _ = w.Write([]byte(html))
}
```

React side — read it before rendering, no API round-trip, no spinner:

```ts
// apps/web/src/lib/boot.ts
export function readBoot<T>(): T | null {
  const el = document.getElementById("__kaata_boot__");
  if (!el?.textContent) return null;
  try { return JSON.parse(el.textContent) as T; } catch { return null; }
}
// SharedLedger page: const boot = readBoot<BootState>() ?? (await api fallback)
```

That's the whole "small thing from Go to React": a JSON `<script>` tag the
server writes and the client reads — effectively `getServerSideProps`, in ~30
lines, reusing the existing SPA. The one contract to keep in sync is the
`BootState` shape (Go struct ↔ a TS type); small enough to hand-maintain.

**Explicitly NOT doing:** Next.js, react-router v7 "framework mode", or Node
SSR. Those buy real React-rendered HTML we don't need — the injected data +
OG meta give us the instant-load + shareable-preview wins at a fraction of the
weight.

## 7. API surface

Mirrors existing conventions (`httpx.JSON`, `httpx.RateLimitPerIP`, uniform 404).

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/v1/l` | public, rate-limited | create; returns `a_token` + `invite_token` |
| POST | `/v1/l/{token}/claim` | invite token | B sets label; mints `b_token` |
| GET | `/v1/l/{token}` | capability token | ledger + entries (the JSON behind §6 boot) |
| POST | `/v1/l/{token}/entries` | capability token | append `{direction, amount, kind, note}` |
| POST | `/v1/l/{token}/entries/{id}/void` | capability token | append a correction |
| GET | `/v1/l/{token}/events` | capability token | SSE live stream (poll fallback) |
| GET | `/l/{token}` | capability token | SSR-lite HTML page (§6) |

Server assigns `seq` (per-ledger monotonic) on append and stamps `created_by`
from the token's role — the client cannot forge attribution.

## 8. Live updates

Server is source of truth, so "sync" is just **tail the entries by seq**. MVP
options, both lean in Go:
- **SSE** (`/v1/l/{token}/events`): server pushes new entries as they land; the
  client appends them. Recommended — it's the "live shared book" feel and chi
  supports it via `http.Flusher`.
- **Poll** every ~8–10 s as a fallback / if SSE proves fiddly behind the proxy.

No CRDT, no conflict resolution: appends are independent and ordered by server
`seq`. Voids reference an entry id. That's it.

## 9. Routing / deployment

Links should live on the main domain for trust + previews: `kaata.af/l/<token>`.
Two ways to wire it (decision in §12):
- **A. Proxy path to backend (recommended):** Dokploy/Traefik routes `/l/*` and
  `/v1/l/*` on `kaata.af` to `kaata-backend`; the backend embeds `index.html`
  and serves the page. Marketing site (`kaata-web`) keeps serving everything
  else. One new path rule.
- **B. Backend on its own host:** serve at `api.kaata.af/l/<token>`. Simpler
  routing, uglier link, weaker brand trust.

Assets: simplest is the backend serving `/assets/*` from the same embedded build
for the `/l` pages; or let `kaata-web` keep serving assets and the backend only
templates the HTML (assets are absolute-pathed, so either works).

## 10. Security & abuse

- Token in path → `RateLimitPerIP` (mirror `InviteInfoLimit`), constant-time
  hash compare, **uniform 404** on any bad/unknown token (no existence leak).
- `amount_minor > 0`, bounded note length, bounded entries/min per token.
- Append-only + voids = full audit trail; nothing is ever silently mutated.
- CORS already handled globally (`httpx.CORS`).
- Known MVP risk (documented to the user): capability-link access; mitigated by
  unguessable tokens + the account-binding upgrade path.

## 11. Relationship to the rest of kaata

- **Mobile local-first ledger: unchanged.** "Ledger data never leaves the
  device" still holds for the shop book. Only the *shared tab* — inherently
  two-party — is server-stored, and only the shared tab.
- **Existing server sync/mesh/chain: not reused here.** That machinery serves
  full-vault replication for signed-in mobile users; it's overkill for a 2-party
  web ledger. Keep this module independent and small.
- **Future (out of scope for v1):** the mobile app surfaces a shared ledger as a
  *linked contact* in your normal book (your balance with "Dairy store" sits
  beside other people, but its entries are the bilaterally-synced shared tab).
  The two-way QR scan already built is the natural in-person link primitive for
  that later step.

## 12. Open decisions (need Matee's call)

1. **Routing (§9):** `kaata.af/l/...` via proxy (recommended) vs `api.kaata.af`?
2. **Who can append:** both parties (recommended — it's a shared book) vs
   one-writer-one-viewer?
3. **Identity:** capability-link-only for MVP (recommended) vs require Google
   sign-in (reuses existing auth, more friction, more durable)?
4. **B's label:** does A name both sides up front, or does B set their own name
   on claim (recommended)?
5. **Live transport:** SSE (recommended) vs poll for the very first cut?

## 13. Phasing

- **M0 — API core:** schema + create/claim/get/append + capability tokens. No UI.
- **M1 — web page:** `/l/:token` React page (plain fetch). Usable end-to-end.
- **M2 — SSR-lite:** the Go→React boot injection + OG meta → instant load +
  WhatsApp previews. (The headline "Next.js level" deliverable.)
- **M3 — live + corrections:** SSE, voids/adjustments, claim-flow polish.
- **M4 — later:** account/phone binding; mobile "linked contact" integration.

Dogfood target: use M1–M2 with the dairy store for one rent cycle, refine from
real use before any mobile work.
