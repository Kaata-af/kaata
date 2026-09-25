import { router } from "expo-router";
import { getAccountIdSync, setActiveVaultId } from "../db-tx";
import { applyVaultCurrency } from "../currency";
import { getTabLink, getPersonIdForRelationship } from "./db";
import { reconcileTabsFromServer, syncTab } from "./sync";

export async function openTabNotification(tabId: string): Promise<void> {
  const account = getAccountIdSync();
  if (!account) throw new Error("Signed out");
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
  router.push({ pathname: "/person/[id]", params: { id: personId } });
}
