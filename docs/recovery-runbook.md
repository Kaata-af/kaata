# Recovery runbook — kaata (Sync v2, M5)

Operator/support reference for the recovery scenarios. The trust model: a vault's root of
trust is the **owner device's Ed25519 key** (the chain anchor); membership is a signed event
chain; the server is a **witness-ACL** (it attests device bindings + enforces push/pull ACL),
NOT a credential issuer. Auth (Google now, OTP later) resolves to a stable neutral
`account_id` — recovery is keyed on the account, not the auth provider.

---

## Scenario A — Lost owner phone, SIGNED IN (the "one year of data" promise)

**Symptom:** owner replaced/factory-reset their phone; they sign in with the same Google
account.

**What happens automatically:** on sign-in, `_layout.tsx` routes a signed-in account with no
local self to `onboarding/restore`, which runs `recoverAllVaults()` (`lib/recovery.ts`):

1. The fresh device mints a new device key and registers it (`/v1/devices/register-key`).
2. `GET /v1/vaults` lists every vault the account belongs to (with each vault's anchor).
3. Per vault: `GET /v1/sync/snapshot` → restore the ledger projection + tail + the **membership
   chain** + **pin the original anchor** (the new device does NOT re-anchor as owner).
4. Per vault: a server-witnessed `vault_device_added` binds the new device key to the member
   account, so the recovered device can author events and MESH.

**Result:** every vault is back (read + write via server immediately; mesh once the witnessed
bind + restored chain are in place). The new device is a fresh REPLICA of the same account.

**If a vault fails to recover:** `recoverAllVaults` continues past failures and reports them;
the next sync tick / a re-run picks them up. A vault with no server snapshot yet (cron lag) is
seeded from the listing and filled by the next pull.

**Support check:** confirm the account is a member server-side (`GET /v1/vaults` returns it)
and that `/v1/sync/snapshot` returns a snapshot for the vault.

---

## Scenario B — Stolen staff phone (remove a member)

**Symptom:** a staff member's phone is lost/stolen; the owner wants to cut its access.

**Action:** the owner removes the member (Members screen → remove). This emits an owner-signed
`vault_member_removed` (and the chain fold sweeps the member's `vault_device_*`). It works
**offline** (gossips device-to-device) and is pushed to the server.

**Effect:** the removed device is refused at the mesh handshake (`isRevoked` early-reject +
the chain fold rejects its membership) and on the server push/pull ACL. A removal the owner
knows wins regardless of what the removed device presents.

**Support check:** `vault_members.revoked_at` is set server-side; the check-in `Revocations`
delta (event-sourced from `vault_members.revoked_at` + `vault_devices.removed_at_ms`) carries
it to other members' fast-path.

---

## Scenario C — Owner-key loss, LOCAL-ONLY vault (NOT recoverable for admin control)

**Symptom:** a vault that was never signed in (no server backup) loses every owner device.

**Reality (honest):** the owner key was the root of trust. With no server copy and no
surviving owner device, **admin control cannot be recovered** — there is no quorum path in v1.
Staff _data_ survives on staff devices (any surviving member device holds the full log and
re-replicates), but issuing new admissions/removals requires creating a **successor vault**.

**Mitigation we ship:** the **backup nag** — local-only vaults with >1 member are aggressively
nudged to sign in (enables cloud backup → Scenario A becomes available). See `lib/recovery`

- the home banner / settings nag (M5 §5).

**Support guidance:** if they have a surviving member device, that device's data is intact;
re-pair the owner's new phone to it (QR, in person) to get the data back, but admin must be
re-established in a new vault.

---

## Scenario D — Solo local-only user, no backup

**Symptom:** one device, never signed in, lost.

**Reality:** Android Auto Backup is the only net (the user's chosen risk). The UI keeps
offering sign-in/backup. Nothing kaata-side can recover it.

---

## Notes for future operators

- **OTP migration is lossless by design** (M1 `account_identities`): when OTP ships, an
  existing Google account links a phone identity onto the SAME `account_id`; all vaults +
  recovery keep working. Recovery code is provider-agnostic (it keys on `account_id`).
- **Server is plaintext-at-rest** (deliberate trust contract). Recovery reads the event log
  back; there is no client-side key to lose for server-synced vaults.
- A recovered device that can read but not MESH is missing either the pinned anchor (legacy
  server-anchored vault → no anchor) or its witnessed device-bind (witness 404 → device key
  not registered first). Check `vault_trust_anchor_pubkey` on the vault row and that
  `/v1/devices/register-key` ran before `/v1/vaults/:id/witness`.
