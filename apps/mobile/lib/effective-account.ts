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
// Returns a deduped, non-empty-string list. Best-effort: never throws (a device
// key that can't be read just yields the passed id, or [] if that's null too).

export async function resolveAccountIdCandidates(
  passedAccountId: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  if (passedAccountId) ids.push(passedAccountId);
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
