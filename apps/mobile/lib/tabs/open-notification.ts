import { router } from "expo-router";
import { getAccountIdSync, setActiveVaultId } from "../db-tx";
import { applyVaultCurrency } from "../currency";
import { getTabLink, getPersonIdForRelationship } from "./db";
import { markInboxHandled, type InboxReadSpec } from "./inbox-reads";
import { reconcileTabsFromServer, syncTab } from "./sync";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let tapSequence = 0;

/**
 * What the tap knew about the notice, as a read spec: the inbox row's id
 * (bell / full inbox) with the tally and rev as tray hints, else the exact
 * tab revision the OS push announced (with the tally as a tray hint), else
 * the tally alone (a push that carried no rev — the entry form is unbounded
 * in time, so it is the last resort), else nothing to mark.
 */
function handledSpec(
  tabId: string,
  entryId: string | undefined,
  opts: { notificationId?: string; rev?: number } | undefined,
): InboxReadSpec | null {
  const rev = opts?.rev != null && opts.rev > 0 ? opts.rev : undefined;
  if (opts?.notificationId) {
    const spec: { id: string; tab_id: string; entry_id?: string; rev?: number } = {
      id: opts.notificationId,
      tab_id: tabId,
    };
    if (entryId) spec.entry_id = entryId;
    if (rev != null) spec.rev = rev;
    return spec;
  }
  if (rev != null)
    return entryId ? { tab_id: tabId, rev, entry_id: entryId } : { tab_id: tabId, rev };
  if (entryId) return { tab_id: tabId, entry_id: entryId };
  return null;
}

export async function openTabNotification(
  tabId: string,
  entryId?: string | null,
  opts?: { notificationId?: string; rev?: number },
): Promise<void> {
  const account = getAccountIdSync();
  if (!account) throw new Error("Signed out");
  if (!UUID.test(tabId)) throw new Error("Invalid tab");
  if (!(await getTabLink(tabId))) await reconcileTabsFromServer();
  const link = await getTabLink(tabId);
  if (!link || getAccountIdSync() !== account) throw new Error("Account unavailable");
  // Sync before routing checks current server access, including removed members.
  const synced = await syncTab(tabId);
  if (!synced.ok) throw new Error("Account unavailable");
  const personId = await getPersonIdForRelationship(link.relationship_id);
  if (!personId || getAccountIdSync() !== account) throw new Error("Contact unavailable");
  await setActiveVaultId(link.vault_id);
  await applyVaultCurrency(link.vault_id);
  const entry = entryId && UUID.test(entryId) ? entryId : undefined;
  router.push({
    pathname: "/person/[id]",
    params: {
      id: personId,
      ...(entry ? { entryId: entry, notificationKey: `${Date.now()}:${++tapSequence}` } : {}),
    },
  });
  // Landing on the tally is handling it (CLAUDE.md "handled means read").
  // After the push and never awaited: a failed mark must not undo navigation.
  const spec = handledSpec(tabId, entry, opts);
  if (spec) {
    try {
      void markInboxHandled(spec).catch(() => undefined);
    } catch {
      /* best-effort */
    }
  }
}
