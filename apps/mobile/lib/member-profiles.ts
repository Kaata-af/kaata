// Current account profiles are mutable and authorized by the server listing.
// Keep them separate from signed membership admission names and role history.
import { applyForCurrentSession, captureCurrentSession } from "./auth";
import { getDb } from "./db-tx";
import { isPlaceholderSelfName, t } from "./i18n";
import { ApiError, listVaults } from "./vault-api";

const requests = new Map<string, number>();

/** Refresh only cosmetic identity data. Never creates or changes membership. */
export async function refreshMemberProfiles(vaultId: string): Promise<boolean> {
  const session = await captureCurrentSession();
  if (!vaultId || !session.accountId || !session.jwt) return false;
  const viewer = session.accountId;
  const key = `${viewer}\0${vaultId}`;
  const request = (requests.get(key) ?? 0) + 1;
  requests.set(key, request);
  const current = () => requests.get(key) === request;

  try {
    const listing = (await listVaults()).find((v) => v.vault_id === vaultId);
    return await applyForCurrentSession(session, async () => {
      if (!current()) return false;
      // Older backends omit members. Preserve usable offline data until a
      // supported server supplies an authoritative profile list.
      if (listing && !Array.isArray(listing.members)) return false;
      const db = await getDb();
      if (!current()) return false;
      let applied = false;
      await db.withTransactionAsync(async () => {
        if (!current()) return;
        await db.runAsync(
          `DELETE FROM vault_member_profiles WHERE viewer_account_id = ? AND vault_id = ?`,
          viewer,
          vaultId,
        );
        for (const member of listing?.members ?? []) {
          if (!member.account_id || typeof member.account_id !== "string") continue;
          await db.runAsync(
            `INSERT INTO vault_member_profiles
               (viewer_account_id, vault_id, account_id, display_name, email, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            viewer,
            vaultId,
            member.account_id,
            realName(member.name),
            typeof member.email === "string" ? member.email.trim() || null : null,
            Date.now(),
          );
        }
        applied = true;
      });
      return applied;
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      // A refused request is different from being offline. Stop showing emails
      // whose authorization was refused, without touching signed ledger data.
      await applyForCurrentSession(session, async () => {
        if (!current()) return;
        const db = await getDb();
        if (!current()) return;
        await db.runAsync(
          `DELETE FROM vault_member_profiles WHERE viewer_account_id = ? AND vault_id = ?`,
          viewer,
          vaultId,
        );
      });
    }
    throw err;
  }
}

function realName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name && !isPlaceholderSelfName(name) ? name : null;
}

/** Name and role occupy different places, even when no name is available. */
export function memberIdentityName(
  member: { has_profile?: number; profile_name?: string | null; display_name?: string | null },
  isSelf: boolean,
  selfName: string | null,
): string {
  // A current profile with no name is an explicit answer. Do not resurrect an
  // old admission name (or another phone's cached name) after a profile clears.
  const name = member.has_profile
    ? realName(member.profile_name)
    : ((isSelf ? realName(selfName) : null) ?? realName(member.display_name));
  if (isSelf) return name ? name + t("members.youSuffix") : t("recovery.selfPlaceholderName");
  return name ?? t("members.nameUnavailable");
}
