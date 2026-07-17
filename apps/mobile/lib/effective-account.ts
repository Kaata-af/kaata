// Resolve every account id that represents "me" for the current device.
//
// A local-CA vault created BEFORE Google sign-in keys its vault_members_mirror
// rows by the deterministic device-key account id (buildLocalAccountId of the
// device pubkey). After the user signs in, app_meta.account_id becomes the
// Google account id. So "am I a member / the only owner?" must be answered
// against BOTH ids — matching only one of them was the root cause of a solo
// owner getting "Failed to leave" (the leave/last-owner checks looked up the
// Google id while the owner row was keyed by the device-key id).
//
// SIGN-OUT COHERENCE: signOut() nulls only the RAM account-id cache while
// app_meta.account_id deliberately survives (the account BINDING outlives the
// session — see scheduler.ts's SessionExpiredError note). Every caller that
// passes getAccountIdSync() therefore passes null right after sign-out, and
// without the persisted fallback below the candidate set collapsed to the
// device-key id alone — flipping vault visibility (listActiveVaults /
// healActiveVaultId) and membership resolution the moment the user signed
// out. Signing out must never change which kaatas are "mine", so the
// persisted binding is always included as a candidate.
//
// Returns a deduped, non-empty-string list. Best-effort: never throws (a device
// key that can't be read just yields the passed id, or [] if that's null too).

export async function resolveAccountIdCandidates(
  passedAccountId: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  if (passedAccountId) ids.push(passedAccountId);
  try {
    // Read the persisted binding directly (NOT refreshAccountIdCache — that
    // would re-prime the RAM cache and make post-sign-out event appends stamp
    // a live actor_account_id again, which auth.ts deliberately prevents).
    const dbTx = await import("./db-tx");
    const db = await dbTx.getDb();
    const row = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'account_id' LIMIT 1",
    );
    const persisted = row?.value ?? "";
    if (persisted && !ids.includes(persisted)) ids.push(persisted);
  } catch {
    /* fall through — return whatever we have */
  }
  try {
    const [deviceKeyMod, accountIdMod] = await Promise.all([
      import("./mesh/device-key"),
      import("./trust/account-id"),
    ]);
    await deviceKeyMod.ensureDeviceKey();
    const pub = deviceKeyMod.getDevicePubkey();
    if (pub) {
      const localId = accountIdMod.buildLocalAccountId(pub);
      if (localId && !ids.includes(localId)) ids.push(localId);
    }
  } catch {
    /* fall through — return whatever we have */
  }
  return ids;
}
