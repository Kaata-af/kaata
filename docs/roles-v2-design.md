# Roles v2 — manager + clerk (design)

Status: DESIGNED 2026-07-26, not yet implemented. Prereq reading:
`docs/m2-membership-chain.md` (chain rules), `lib/vault-roles.ts` (UI matrix),
`lib/projection/role-gate.ts` REQUIRED_ROLE, `apps/backend/internal/sync/permissions.go`.

## Why

Shopkeeper reality: a brother who runs the shop when you're away (should manage
staff but not own the kaata), and a helper who writes sales into the book but
must never edit or delete history. Today's model (owner/editor/viewer) can't
express either.

## New vocabulary

Linear rank order (every enforcement layer assumes a total order — keep it):

```
viewer(1) < clerk(2) < editor(3) < manager(4) < owner(5)
```

- **clerk** — append-only. Can author `entry_created`, `person_added`. Cannot
  amend/delete entries, rename/archive people, or touch vault settings. The
  "helper with a pen, not an eraser" role.
- **manager** — everything editor can do, plus member management **capped below
  manager**: invite/remove/role-change members whose current AND new role rank
  < manager. Cannot touch owner or manager rows, cannot transfer ownership,
  cannot archive the vault. Shop-profile + vault settings: manager+.

## The hard constraint: shipped clients

A new role VALUE inside existing membership events breaks 1.0.2 clients four
ways (verified in the 2026-07-26 system map):

1. SQLite CHECK `role IN ('owner','editor','viewer')` on `vault_members_mirror`
   (db.ts migration 007) + `pending_invitations` → applier aborts, eternal
   sweep retry.
2. Chain fold strict parse → `malformed_payload` refusal → member invisible,
   their writes quarantine as `unknown_actor`.
3. `rankRole`/`roleRank` unknown → 0 → locked out of everything on new servers.
4. **Silent escalation**: five paths clamp unknown roles UP to `'editor'`
   (recovery.ts:346/427, trust/backfill.ts:191, mesh/anti-entropy.ts:1560,
   mesh/pair-qr.ts:183, pair-scan.tsx:47) — a clerk would get editor powers on
   an old mesh peer.

Postgres side: CHECK on `vault_members` (migration 006) + mesh credentials
(009); `isValidMemberRole` fold-skips unknown roles (event kept, seat never
materializes).

## Two-phase rollout

**Phase A — "understanding" release (target 1.0.3):** every layer learns the
new roles; nobody can grant them yet.

- Mobile: widen `VaultRole` in BOTH `lib/events.ts` and `lib/trust/chain.ts`
  (independently declared — change together). New migration rebuilds
  `vault_members_mirror` + `pending_invitations` with the widened CHECK
  (SQLite can't ALTER a CHECK; append-only migration). Extend `rankRole`,
  `meetsRequirement` (drop the two-tier special-case for a rank comparison),
  PERMISSIONS matrix columns, role labels en+fa, pill styles, sort order.
  Fix the five unknown-role clamps to clamp DOWN to `'viewer'`, never editor.
  Split `useActiveVaultCanWrite` into canCreate/canAmend (clerk shows the
  add/find FAB but no edit affordances). Widen `RoleGateRejectionError.required_role`.
- Mobile chain rules (inert until a manager exists): membership events
  authorized for owner-bound devices (as today) OR manager-bound devices
  when target's current role AND the event's new role both rank < manager.
  Witness cap `role === 'owner'` becomes `rank(role) >= rank(manager)`.
  Last-owner guards unchanged — 'owner' literal remains correct there.
  Genesis unchanged (owner only).
- Backend: migration relaxes both CHECKs; extend `isValidMemberRole`,
  `isValidRole`, `roleRank`, `requiredRoleFor` (entry_created/person_added →
  'clerk'; amend/delete/rename/archive → 'editor'; shop_profile_updated +
  vault_setting_set → 'manager'; membership events keep 'owner' + the same
  manager-cap arm as mobile), witness owner-cap → manager-cap.
  CreateInvite accepts `clerk` (NOT manager — witnessed admissions must stay
  below manager; manager is granted by owner-signed role_changed after join).
- Reconcile the two pre-existing gate divergences while touching the tables:
  `shop_profile_updated` manager+ on BOTH sides (was mobile-owner vs
  server-editor); `person.archive` editor+ everywhere (matches enforcement;
  the UI table's owner-only cell was dead code).
- Deploy order: backend (with migration) FIRST, then mobile release.

**Phase B — "granting" release (1.1.0 or later):** UI only. Invite screen
offers clerk; members sheet offers "Make clerk" / "Make manager" (owner sees
manager, manager sees ≤editor). Gate: ship only when check-in metrics show the
active fleet ≥ Phase-A version (admin dashboard has per-install versions), or
force-update via `min_supported_version` if a straggler must be cut over.

## Phase B — SHIPPED 2026-07-27

Fleet check passed (only the operator's own devices are members of shared
kaatas; both on ≥1.0.3). Shipped: REST gates re-widened (SetMemberRole
grants all roles for owners; CreateInvite adds clerk), member-management
endpoints accept MANAGER callers with the below-manager cap
(requireOwnerOrManager), clerk in the invite picker, Make manager/clerk in
the member sheet, and manager-authored mutations route through REST
(server-arbitrated) per blocker #1 below — owners keep offline events.
Rule that remains: every member of a kaata must be on ≥1.0.3 before a
manager/clerk is minted IN that kaata.

## Phase B blockers (from the 2026-07-26 adversarial review — resolved above)

Resolve BEFORE the granting UI ships — all are inert while no manager exists:

1. **Target-role race (current-state guard vs ordered fold).** Manager
   authorization depends on the TARGET's current role, which the three
   layers resolve from non-equivalent sources (fold: full chain state;
   gate: applied event_log at append time; server: audit rows at arrival
   time). Concrete split: owner promotes E→manager at T1 while offline
   manager M removes E at T2 — M's gate applies locally, the server and
   M's own fold refuse, and applied events are never re-examined.
   RECOMMENDED FIX: route manager-authored membership mutations through
   REST (server-arbitrated, like ownership transfer) in the Phase B UI
   instead of offline chain events; owners keep offline authoring. The
   alternative (fold-driven reconciliation of applied membership
   projections) is bigger and benefits owners too — decide then.
2. **Re-widen the REST Phase A gates**: `phaseAGrantable` in
   vaults/service.go (SetMemberRole) and the CreateInvite editor/viewer
   cap — plus the mobile pickers, sheet actions, and rejection-toast copy
   (i18n `entry.roleDenied` phrasing assumes editor-vs-viewer).
3. **roleAtHLC audit-gap hardening** (best-effort mirror can miss
   chain-granted roles for unmirrorable accounts): acceptable for Phase B
   if manager mutations go through REST (server state is then the
   arbiter); revisit if offline manager authoring ships instead.

## Explicitly rejected

- Per-permission ACLs / custom roles: three shops out of ~80 installs use
  members at all today; a matrix editor is complexity nobody asked for.
- Manager-via-witness (invite directly as manager): a leaked server witness
  key must never mint a member-managing seat; manager stays owner-signed.
- Breaking the linear rank order (e.g. auditor ⊥ clerk): every layer assumes
  a total order; partial orders would rewrite meetsRequirement/roleSatisfies
  semantics for marginal value.
