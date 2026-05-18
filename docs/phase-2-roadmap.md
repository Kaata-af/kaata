# Kaata Phase 2+ Roadmap

## Phase 1 (current): Private notebook with WhatsApp ping

Shopkeeper records what they're owed AND what they owe — direction is derived from the running net balance per person, not assigned at creation. "Ping" button opens WhatsApp on the shopkeeper's phone with a pre-filled message: receiver-perspective signed amount, a red 🔴 / green 🟢 indicator, a polite action line, and "— Sent via Kaata.af" branding. The other party never installs anything. No backend ledger sync.

## Phase 2: Mutual ledger (when customer-side app launches)

When a customer's phone number on a new Kaata signup matches an existing user record with no `is_local_self` mark, merge identities: the existing user record becomes a real authenticated user, and any historical entries become visible from their side.

New entries created by the shopkeeper send an in-app push notification to the customer-side app: "Shop X added 1,250 AFN to your kaata." Customer taps Accept (sets `accepted_at`), Dispute (sets `disputed_at` and `disputed_reason`), or Ignore (no action).

Disputed entries are flagged in the shopkeeper's view with a resolution UX: shopkeeper can edit the entry (which re-triggers acceptance flow) or void it.

The WhatsApp ping path remains as fallback for non-Kaata customers.

## Phase 3: Netting clearinghouse

Algorithm runs server-side over the global graph of accepted obligations. Finds cycles (A owes B, B owes C, C owes A). Proposes settlement to all parties. When all parties approve, all three obligations are marked `settled_at` simultaneously. No money moves through Kaata — only the graph state changes.

Bilateral netting (A owes B 500, B owes A 200, net = A owes B 300) is the simplest case and ships first.

## Phase 4: Settlement layer

For obligations that can't be netted, integrate with multiple Afghan payment rails (HesabPay, AfPay, direct bank, hawala network APIs). User picks rail per settlement. Kaata records that money moved off-platform; never custodies.

Optional Islamic finance integration for working-capital advances against verified obligation history. Lender partner takes credit risk; Kaata takes referral fee.

## Multi-shop / vaults (orthogonal to phases; planned, not scheduled)

A single shopkeeper may eventually run more than one shop and want to keep each kaata book separate — same person, different contexts. Think Obsidian's vaults: pick which one you're "in" right now.

v0 explicitly forbids this with `shop_profile CHECK (id = 1)`. The migration path when we ship multi-shop:

- Rename `shop_profile` → `shops`; drop the single-row check; add an `archived_at` column for the same reason `relationships` and `users` have one.
- Add `shop_id TEXT NOT NULL REFERENCES shops(id)` to `relationships`. Backfill with the existing single shop's id for every existing row. Drop the implicit "scoped via `user_a_id = local_self`" model — `shop_id` becomes the canonical scope key.
- Add `active_shop_id` to `app_meta`. The UI's shop-switcher writes to this; every query reads it.
- Update list/get/create functions in `lib/db.ts` to filter by the active shop. `listCustomersWithBalances()` joins `relationships` and now filters on `shop_id = ?`.

**Key decisions baked into this plan:**

- **Users stay global per install.** The same Ahmad with the same phone is one `users` row whether you sold him goods from your bazaar shop or your grocery — but you have _two relationships_ with him, one per shop, each with its own kaata history. This matches reality: Ahmad is one person, but his account at your bazaar shop is unrelated to his account at your grocery.
- **Entries stay attached to relationships, not shops directly.** The shop scope flows transitively through the relationship. No changes needed to the entries table.
- **The shopkeeper's local-self user stays single.** It's still _you_ across all your shops, just like Obsidian uses one identity across vaults.

**Not building any of this in v0.** The cost of foundation work now (every screen needs an active-shop selector even when there's only one shop) outweighs the cost of a forward-only migration later (`002_add_shop_scope.sql` is half a page of SQL plus query-layer updates with the same signatures).

This sits orthogonal to Phase 2-4 above and can ship in any of them. Most likely candidate: bundled with Phase 2 since adding push-notification routing and dispute flows already requires the mobile app to know "which shop did this entry happen at."

## Architecture principles

- Never custody money in Phase 1-3.
- Phone numbers are canonical identity. Email is never collected.
- Every user is just a `user` row. Roles are defined by `relationships.context` and can vary per relationship.
- Settlement is always recorded by both parties before being committed (Phase 2+).
- The shopkeeper-of-today might be the customer-of-tomorrow at another shop. Schema must support this from day one.
- One install can hold multiple shop contexts (see "Multi-shop / vaults" above); the schema can absorb that with one additive migration when the time comes.
