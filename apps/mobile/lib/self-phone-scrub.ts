// apps/mobile/lib/self-phone-scrub.ts
//
// One-time historical-data cleanup: null the phone on any CONTACT that wrongly
// carries the shopkeeper's OWN number.
//
// Background. Before the createPerson/updatePerson self-phone guard existed, the
// duplicate-contact scan (findPhoneConflictInVault) only matched the local-self
// once it already sat in a relationship — so the VERY FIRST contact a shopkeeper
// added with their own number slipped through. That violates the canonical
// identity rule underpinning the payment-rails vision — "one phone = one actor":
// the shopkeeper ended up as both the ledger owner AND one of their own
// counterparties. The guard now blocks it going forward; this clears the rows
// that leaked before the guard shipped.
//
// Why this is NOT a db.ts migration. The leaked number lives in the
// `person_added` EVENT payload, which is the source of truth and is pushed to
// the backend (and any other devices). A raw projection UPDATE — the migration
// idiom (see migrations 020/021) — pushes nothing, so a reinstall/restore would
// re-project the leaked phone straight back from the backend's copy. The durable
// fix is to emit a `person_phone_changed` event that supersedes the phone field
// (projection field-HLC is last-writer-wins per field) and rides the normal push
// outbox. Emitting events needs install/account/self/signing context, which is
// only guaranteed once the sync scheduler is running — so this lives there as a
// one-shot backfill (mirroring the M2 chain backfill), app_meta-gated so it does
// real work exactly once ever.
//
// See docs/identity-and-vaults.md for the layering this enforces.

import { getDb, getAppMeta, setAppMeta } from "./db";
import { appendPersonPhoneChanged } from "./event-log";

const SCRUB_FLAG = "self_phone_contacts_scrubbed_v1";

// In-session guard so repeated scheduler starts within one app run don't re-scan.
let ranThisSession = false;

export async function ensureSelfPhoneContactsScrubbed(): Promise<void> {
  if (ranThisSession) return;
  ranThisSession = true;

  const db = await getDb();
  if ((await getAppMeta(SCRUB_FLAG)) === "1") return;

  // The shopkeeper's own number (global; the single is_local_self row).
  const self = await db.getFirstAsync<{ phone_e164: string | null }>(
    "SELECT phone_e164 FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  const selfPhone = self?.phone_e164 ?? null;

  // No own number set → nothing could have leaked. Stamp the flag so we never
  // re-scan; the forward guard prevents any new leak regardless.
  if (!selfPhone) {
    await setAppMeta(SCRUB_FLAG, "1");
    return;
  }

  // Every active CONTACT (is_local_self = 0) that carries the self's number,
  // paired with a vault it is active in. DISTINCT collapses a contact present in
  // several vaults to one row per (contact, vault) so each gets its own
  // superseding event. Leaked contacts only exist in vaults this device can
  // write to (createPerson is role-gated), so the emit below is never refused.
  const leaked = await db.getAllAsync<{ user_id: string; vault_id: string }>(
    `SELECT DISTINCT u.id AS user_id, r.vault_id AS vault_id
       FROM users u
       INNER JOIN relationships r
          ON r.user_b_id = u.id AND r.archived_at IS NULL
       INNER JOIN vaults v
          ON v.id = r.vault_id AND v.archived_at IS NULL
      WHERE u.is_local_self = 0
        AND u.phone_e164 = ?`,
    selfPhone,
  );

  // Emit a real phone-change (→ null) per leaked contact. appendPersonPhoneChanged
  // applies to the projection AND enqueues the event for push; an already-null
  // contact is a no-op (returns null).
  let failures = 0;
  for (const row of leaked) {
    try {
      await appendPersonPhoneChanged({
        userId: row.user_id,
        vaultId: row.vault_id,
        phoneE164: null,
      });
    } catch (err) {
      failures++;
      console.warn("[self-phone-scrub] failed for contact", row.user_id.slice(0, 8), err);
    }
  }

  // Stamp the flag only when every leaked contact was cleared. A transient
  // failure leaves it unset so the next scheduler start retries the remainder —
  // already-cleared contacts no longer match the scan, so it converges.
  if (failures === 0) await setAppMeta(SCRUB_FLAG, "1");
}
