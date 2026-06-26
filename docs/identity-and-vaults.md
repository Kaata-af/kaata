# Identity vs. Vaults — the layering the rails vision needs

Design note, written 2026-06-27. Captures a decision so the model doesn't drift
back to it as Phase 2 sharing hardens. TL;DR: **keep multi-vault, but treat
phone/account identity as a global layer that sits _above_ vaults — not as a
per-vault property.** The mistake to avoid is letting vault-scoping erode the
"one phone = one actor" invariant that payment rails + invoicing depend on.

## The target layering

The grand vision (payment rails, invoice sending) makes a phone number the
**address of an economic actor** — the thing an invoice is sent _to_, a payment
settles _to_, a balance reconciles _against_. That demands one hard invariant:

> **One phone = one actor.**

The model that satisfies this — and the one every serious payments/invoicing
product converges on (Stripe accounts, QuickBooks companies, Wave businesses) —
is a single global identity that participates in many containers:

```
account / phone        ← global, canonical identity. ONE per real actor.
       │  participates in many
       ▼
    vaults              ← containers / books. The unit of sharing & settlement.
       │                  MANY per identity.
       ▼
  users + relationships + entries     ← the ledger inside a vault.
```

The schema is already **halfway** here: `vaults.account_id`, account-keyed
`vault_members`, and role-gates that authenticate on `account_id`
(`apps/mobile/lib/db.ts`, `apps/mobile/lib/projection/role-gate.ts`). The account
layer exists. What's missing is treating it as the _authority_ for identity,
rather than re-deriving identity per vault.

## Was multi-vault wise? Yes as an end-state; early as timing.

**Keep it.** A real shopkeeper isn't one book: own shop, family shop,
partnership, a savings committee (ROSCA), a side business. More structurally, the
**vault is the unit of sharing and settlement** — Phase 2 collaboration (members,
roles, invites) has nowhere to live without a vault boundary, and the B2B network
you're building toward _is_ a graph of vaults connected by shared phone
identities. Deleting multi-vault would just mean rebuilding it for Phase 2.

**But it arrived before the single-vault product found retention, and it has cost
us in one specific, load-bearing way:**

1. **It weakened the identity invariant.** To allow "the same person in multiple
   vaults," the global `UNIQUE(users.phone_e164)` was dropped and uniqueness moved
   into per-vault application code (`db.ts` migration 016/017 era;
   `findPhoneConflictInVault` in `apps/mobile/lib/event-log.ts`). Per-vault
   uniqueness is a fuzzy relationship-join, not a hard guarantee — and that fuzz
   is the root of the self-leak below.
2. **It's invisible tax for today's user.** Real users are solo shopkeepers;
   `SOLO_STORE_MODE` exists to _hide_ multi-vault. So it currently threads
   `getActiveVaultIdSync()` through every query, cross-vault stale-UI guards, and
   restore/recovery `user_a_id` remapping — carried before it pays for itself.

The synthesis: don't rip out multi-vault, but **stop letting vault-scoping be the
authority on identity.** Identity is global; vaults are containers.

## The self-leak: a symptom of conflating the two layers

The shopkeeper ("self") is modeled as just another `users` row, flagged
`is_local_self = 1`, carrying their own `phone_e164`. Because per-vault phone
uniqueness is a relationship-join scan, the self only got caught _once it sat in a
relationship_ — so the very first contact a shopkeeper added with **their own
number** slipped through, and the shopkeeper became one of their own
counterparties. That's the "one phone = one actor" invariant breaking in
miniature, purely because the identity layer (the self) was indistinguishable
from the container layer's contents (a `users` row in a per-vault scan).

### What we did about it (2026-06-27)

First enforcement of the invariant, deliberately small and contained:

- **Forward guard.** `createPerson` / `updatePerson` (`apps/mobile/lib/db.ts`) now
  do an explicit, deterministic check: the entered number can't equal the
  local-self's number. Returns a distinct `phone_is_self` result so the UI says
  _"That's your own number"_ instead of the misleading _"Phone already used by
  &lt;your name&gt;"_. This is independent of the relationship-join, so it also
  blocks the first-contact case the old scan missed.
- **Honest scan.** `findPhoneConflictInVault` now excludes `is_local_self` — the
  duplicate-_contact_ scan is about contacts only; the self is handled upstream.
- **Durable historical cleanup.** `apps/mobile/lib/self-phone-scrub.ts`, a
  one-shot backfill hosted in the sync scheduler, emits a real
  `person_phone_changed` event to null any contact that already leaked. It is
  **not** a `db.ts` migration on purpose: the leaked number lives in the
  `person_added` _event payload_ (the source of truth, pushed to the backend), so
  a raw projection `UPDATE` would be re-projected straight back on reinstall/
  restore. Only a superseding event (field-HLC last-writer-wins) is durable and
  syncs. See that file's header for the full reasoning.

## Guidance for future work

- **Identity decisions belong to the account/phone layer, not the vault.** When
  adding anything that resolves or dedupes people by phone, resolve against the
  global identity first; use the vault only to scope _membership_ and _ledger
  visibility_.
- **The self is a first-class identity, not a contact.** Don't write code paths
  that let the self fall into contact-scoped scans. The `is_local_self` exclusion
  above is the pattern to copy.
- **On rails, "this contact's number is a registered kaata account" should
  _link_, not mint a local stub.** That's the opposite of loosening uniqueness —
  it's the direction the vision pulls. Keep walking toward identity resolution.
- **Before hardening Phase 2 sharing**, decide where canonical phone uniqueness
  lives. Per-vault app-code uniqueness is a stopgap, not the end-state.
