import { router } from "expo-router";
import { captureCurrentSession, applyForCurrentSession } from "./auth";
import { getSessionAccountIdSync, getDb, setActiveVaultId } from "./db-tx";
import { getPersonProfile } from "./friends-api";
import { listPeopleRequests } from "./people-connections";
import { listVaultMemberRequests } from "./vault-member-requests";
import { listVaults } from "./vault-api";
import { applyVaultCurrency } from "./currency";
import { isConnectionNotice } from "./notification-events";
import { markInboxHandled } from "./tabs/inbox-reads";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function parseConnectionNotification(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    !isConnectionNotice(data) ||
    typeof data.recipient_account_id !== "string" ||
    !UUID.test(data.recipient_account_id)
  )
    return null;
  const id = data.notification_id ?? data.id;
  if (typeof id !== "string" || !/^\d+$/.test(id) || id === "0") return null;
  return {
    id,
    kind: String(data.kind),
    account: data.recipient_account_id,
    source: typeof data.source_id === "string" && UUID.test(data.source_id) ? data.source_id : null,
    actor:
      typeof data.actor_account_id === "string" && UUID.test(data.actor_account_id)
        ? data.actor_account_id
        : null,
    vault: typeof data.vault_id === "string" && UUID.test(data.vault_id) ? data.vault_id : null,
  };
}

/** A notification only selects a server-validated destination. Opening a push
 * never accepts an invitation, grants access, or trusts a payload token. */
export async function openConnectionNotification(
  value: unknown,
  canOpen: () => boolean = () => true,
): Promise<void> {
  const notice = parseConnectionNotification(value);
  if (!notice || !canOpen() || notice.account !== getSessionAccountIdSync()) return;
  const session = await captureCurrentSession();
  const current = () =>
    canOpen() &&
    session.accountId === notice.account &&
    getSessionAccountIdSync() === notice.account;
  const guard = async () => {
    await applyForCurrentSession(session, async () => {});
    return current();
  };
  if (!session.jwt || !(await guard())) return;
  let route: Parameters<typeof router.push>[0] = "/notifications";
  try {
    if (notice.kind === "shared_invite_requested" && notice.source) {
      const request = (await listPeopleRequests()).find((item) => item.id === notice.source);
      if (!(await guard())) return;
      if (request) route = { pathname: "/t/[token]", params: { token: request.token } };
    } else if (notice.kind === "vault_invite_requested" && notice.source) {
      const request = (await listVaultMemberRequests()).find((item) => item.id === notice.source);
      if (!(await guard())) return;
      if (request) route = { pathname: "/invite/[token]", params: { token: request.token } };
    } else if (notice.kind.startsWith("vault_") && notice.vault) {
      const vault = (await listVaults(session)).find(
        (item) => item.vault_id === notice.vault && !item.archived_at_ms,
      );
      if (!(await guard())) return;
      if (vault) {
        const local = await (
          await getDb()
        ).getFirstAsync<{ id: string }>("SELECT id FROM vaults WHERE id=?", vault.vault_id);
        if (!(await guard())) return;
        if (!local) {
          const { recoverJoinedVault } = await import("./recovery");
          const recovered = await recoverJoinedVault(vault.vault_id, session);
          if (!(await guard())) return;
          if (!recovered)
            throw new Error("Kaata is temporarily unavailable; retry the notification");
        } else {
          const { pullEvents } = await import("./sync/pull");
          await pullEvents(vault.vault_id, session);
          if (!(await guard())) return;
        }
        await applyForCurrentSession(session, async () => {
          if (current()) {
            await setActiveVaultId(vault.vault_id);
            await applyVaultCurrency(vault.vault_id);
          }
        });
        if (!(await guard())) return;
        route = "/vault/members";
      }
    } else if (notice.actor) {
      const profile = await getPersonProfile(notice.actor, session);
      if (!(await guard())) return;
      route = { pathname: "/people/[accountId]", params: { accountId: profile.person.account_id } };
    }
  } catch (error) {
    // A removed account or a cancelled invitation remains readable as history.
    // Network failures remain retryable and never mark the notice as opened.
    if (![403, 404, 410].includes(Number((error as { status?: unknown })?.status))) throw error;
  }
  if (!(await guard())) return;
  router.push(route);
  void markInboxHandled({ id: notice.id }).catch(() => undefined);
}
