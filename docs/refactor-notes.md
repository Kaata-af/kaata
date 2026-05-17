# Phase 2 Schema Refactor — Notes

A purely structural refactor. No user-visible behavior changes; all v0 acceptance criteria still pass. The goal was to land the schema that Phase 2 (mutual ledger, dispute flows, multi-role identity) needs _without_ shipping any Phase 2 features yet — so future work becomes migrations instead of refactors.

## What changed

### SQLite schema

| v0                        | v1                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `shopkeeper` (single row) | `users` (anyone — shopkeeper, customer, future supplier) + `shop_profile` (single row) referencing the local-self user                     |
| `customers`               | `users` (the customer side) + `relationships` (binding shop's local-self user to the customer user with `context = 'customer'`)            |
| `entries.customer_id`     | `entries.relationship_id` + nullable Phase 2 columns: `proposed_by_user_id`, `accepted_at`, `disputed_at`, `disputed_reason`, `settled_at` |
| no migration tracking     | `schema_migrations` table                                                                                                                  |

The `app_meta` table is untouched.

### One-shot migration (`001_v0_to_users_relationships`)

In [apps/mobile/lib/db.ts](../apps/apps/mobile/lib/db.ts). Runs on first launch of the new build:

1. Detects v0 by the existence of the `customers` table.
2. If v0 is present, reads `shopkeeper` / `customers` / `entries` into memory.
3. Inside a single transaction:
   - Drops `entries` and `customers`. Renames `shopkeeper` → `_old_shopkeeper` (retained as safety copy — do not drop until at least one release later).
   - Creates the new tables.
   - Inserts a `users` row with `is_local_self = 1` for the shopkeeper, then a `shop_profile` row referencing it.
   - For each old customer: inserts a non-self `users` row + a `relationships` row with `context = 'customer'`, recording the old customer-id → new relationship-id mapping in JS.
   - For each old entry: inserts into the new `entries` table using the mapped relationship-id, with `proposed_by_user_id` set to the local-self user.
   - Records the migration in `schema_migrations`.

The whole migration is one transaction — an interrupted run rolls back cleanly and retries on the next launch.

### Phone normalization

New module: [apps/mobile/lib/phone.ts](../apps/apps/mobile/lib/phone.ts). `normalizePhone` converts any reasonable input (`0701234567`, `+93 70 123 4567`, `93701234567`) to E.164 `+937XXXXXXXX`. Returns null for non-Afghan-mobile inputs. `formatPhoneForDisplay` renders E.164 as `+93 70 123 4567` (currently exported but unused by v1 screens).

Phones are normalized inside `createCustomer` (runtime) and during the migration.

At runtime, `createCustomer` no longer silently drops bad input. It returns a discriminated `CreateCustomerResult` so the new-customer screen can show targeted errors:

- `phone_invalid` — input was non-empty but didn't normalize to a valid Afghan mobile.
- `phone_conflict` — input normalized fine, but another user already has it. The result carries that user's id and display name so the screen can name them in the alert.
- `ok` — customer was saved (the id is returned in case the caller wants to navigate to it).

The migration runs without a user to prompt, so it preserves the customer row and stores the phone as NULL. It also counts how many phones it had to drop, split into two `app_meta` keys — `migration_001_phones_invalid_count` and `migration_001_phones_conflict_count` — which the next check-in includes in its payload. The backend has matching `installs.migration_001_phones_invalid` / `installs.migration_001_phones_conflict` columns; the UPSERT uses `COALESCE` so a later check-in without the fields doesn't blank them out.

### Query layer (lib/db.ts)

Function signatures match v0 exactly — every screen's call sites are unchanged. The implementation now joins `relationships` and `users` to produce the `CustomerWithBalance` view that the rest of the app expects. The `id` field returned (and accepted by `getCustomer`, `listEntries`, `createEntry`, `archiveCustomer`) is now `users.id` (the customer's user-id), which screens treat opaquely.

### Types (lib/types.ts)

- New storage types: `User`, `ShopProfile`, `Relationship`, `RelationshipContext`.
- `Entry` now carries `relationship_id` instead of `customer_id`, plus the Phase 2 nullable fields. No screen reads these fields.
- `Customer` / `CustomerWithBalance` / `Shopkeeper` are kept as view types with v0-compatible field names so the rest of the app doesn't churn.

## What did NOT change

- Every screen file under `mobile/app/`.
- Every component under `mobile/components/`.
- The check-in flow (`lib/api.ts`, `lib/install-id.ts`, `lib/app-meta-context.tsx`, `components/UpdateBanner.tsx`, `app/update-prompt.tsx`).
- WhatsApp share (`lib/share.ts`) — it reads `customer.name` and `customer.phone`, both still present.
- The `app_meta` table.
- Every file under `backend/` and `web/`.

## Things that are slightly different but acceptable

- A v0 install with two customers sharing the same phone: the second customer's phone is migrated as NULL (UNIQUE constraint on `users.phone_e164`). Their entries still migrate intact. The migration records this in `app_meta.migration_001_phones_conflict_count` and reports it back via the next check-in.
- An ill-formed phone in v0 (e.g. "ABC") is migrated as NULL, recorded in `app_meta.migration_001_phones_invalid_count`, and reported the same way.
- At runtime, a duplicate or unparseable phone no longer silently saves the customer with NULL — `createCustomer` returns a typed error and the screen surfaces it.
- The customer list is now ordered by `balance ASC, display_name ASC` so the most-indebted customers appear first — matches v0 spec.

## When this can be cleaned up

After at least one release on v1 with no migration regressions reported, drop `_old_shopkeeper` in a follow-up migration `002_drop_old_shopkeeper.sql`. Don't do it sooner — that's the only direct backup of the shop's identity row.
