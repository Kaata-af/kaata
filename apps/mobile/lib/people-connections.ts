import { getBackendUrl } from "./api";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import { getActiveVaultArchivedState, getPerson, setAppMeta } from "./db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import { appendPersonAdded } from "./event-log";
import type { DiscoveredPerson } from "./people-search";
import { notifyPeopleSearchChanged } from "./people-search-events";
import { assertVaultAction } from "./tabs/link";
import { TabApiError, TabAuthUnavailableError, TabInputError } from "./tabs/errors";
import { KAATA_UUID_NAMESPACE, uuidv5 } from "./uuid-v5";

export type PeopleRequest = {
  id: string;
  group_id: string;
  token: string;
  from: DiscoveredPerson;
  created_at_ms: number;
};
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Stable identities make retrying after a lost reply safe, including on another
 * phone with the same book. A name is never evidence that two people are one. */
export function discoveredPersonId(vaultId: string, accountId: string): string {
  return uuidv5(KAATA_UUID_NAMESPACE, `discovered-person:${vaultId}:${accountId}`);
}

export async function getDiscoveredPersonIds(vaultId: string): Promise<Record<string, string>> {
  const account = getAccountIdSync();
  if (!account) return {};
  const rows = await (
    await getDb()
  ).getAllAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key LIKE ?",
    `discovered_contact:${account}:${vaultId}:%`,
  );
  if (getAccountIdSync() !== account) return {};
  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      const value = JSON.parse(row.value);
      if (typeof value.accountId === "string" && typeof value.personId === "string")
        result[value.accountId] = value.personId;
    } catch {
      /* Ignore an incomplete local cache. */
    }
  }
  return result;
}

export async function peopleRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  expectedSession?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<T> {
  const session = expectedSession ?? (await captureCurrentSession());
  if (!session.jwt || !session.accountId) throw new TabAuthUnavailableError();
  const base = await getBackendUrl();
  await applyForCurrentSession(session, async () => {});
  beforeDispatch?.();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) throw new TabAuthUnavailableError();
      const error = await response.json().catch(() => ({}));
      throw new TabApiError(
        response.status,
        error.error_code ?? `http_${response.status}`,
        "People request failed",
      );
    }
    const result = response.status === 204 ? undefined : await response.json();
    return applyForCurrentSession(session, async () => result as T);
  } catch (error) {
    if (
      error instanceof TabApiError ||
      error instanceof TabAuthUnavailableError ||
      error instanceof SessionChangedError
    )
      throw error;
    if (getAccountIdSync() !== session.accountId) throw new TabAuthUnavailableError();
    throw new TabApiError(0, "network", "People request unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export async function listPeopleRequests(): Promise<PeopleRequest[]> {
  const result = await peopleRequest<{ requests: PeopleRequest[] }>("GET", "/v1/people/requests");
  if (!Array.isArray(result?.requests))
    throw new TabApiError(503, "invalid_response", "Invalid invitation list");
  const seen = new Set<string>();
  return result.requests.slice(0, 50).filter((item) => {
    if (
      !item ||
      !UUID.test(item.id) ||
      !UUID.test(item.group_id) ||
      item.token !== `r_${item.id}` ||
      !item.from ||
      !UUID.test(item.from.account_id) ||
      typeof item.from.name !== "string" ||
      (item.from.username !== undefined && typeof item.from.username !== "string") ||
      !Number.isSafeInteger(item.created_at_ms) ||
      seen.has(item.id)
    )
      return false;
    seen.add(item.id);
    return true;
  });
}

export async function sendPeopleRequest(
  groupId: string,
  accountId: string,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<void> {
  await peopleRequest(
    "POST",
    "/v1/people/requests",
    {
      group_id: groupId,
      recipient_account_id: accountId,
    },
    session,
    beforeDispatch,
  );
}

export async function ensurePeopleDiscovery(session: SessionSnapshot): Promise<void> {
  const result = await peopleRequest<{ people_discovery?: boolean }>(
    "GET",
    "/v1/sync/capabilities",
    undefined,
    session,
  );
  if (result.people_discovery !== true)
    throw new TabApiError(
      503,
      "shared_account_unsupported",
      "People discovery requires a server update",
    );
}

export async function declinePeopleRequest(id: string): Promise<void> {
  await peopleRequest("DELETE", `/v1/people/requests/${encodeURIComponent(id)}`);
}

/** Called only by the existing invitation dialog's explicit confirmation. */
export async function prepareDiscoveredContact(
  person: DiscoveredPerson,
  session: SessionSnapshot,
  vaultId: string,
  existingPersonId?: string | null,
): Promise<string> {
  const current = () => {
    if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== session.accountId)
      throw new TabAuthUnavailableError();
  };
  current();
  await ensurePeopleDiscovery(session);
  current();
  if (person.account_id === session.accountId) throw new TabAuthUnavailableError();
  await assertVaultAction(vaultId, "entry.amend");
  current();
  const guard = await getActiveVaultArchivedState();
  current();
  if (guard.state !== "ok") throw new TabInputError("no_active_vault");
  return applyForCurrentSession(session, async () => {
    current();
    const identities = await getDiscoveredPersonIds(vaultId);
    current();
    const id =
      existingPersonId ||
      identities[person.account_id] ||
      discoveredPersonId(vaultId, person.account_id);
    if (
      Object.entries(identities).some(
        ([account, localId]) => account !== person.account_id && localId === id,
      )
    )
      throw new TabApiError(409, "group_conflict", "This contact belongs to another account");
    const remember = async () => {
      current();
      await setAppMeta(
        `discovered_contact:${session.accountId}:${vaultId}:${person.account_id}`,
        JSON.stringify({ accountId: person.account_id, personId: id }),
      );
      current();
      if (session.accountId) notifyPeopleSearchChanged({ accountId: session.accountId, vaultId });
      return id;
    };
    const existing = await getPerson(id);
    current();
    if (existing && existing.archived_at == null) return remember();
    // Never resurrect an archived financial relationship implicitly.
    if (existing) throw new TabApiError(409, "contact_archived", "Restore this contact first");
    const db = await getDb();
    current();
    const relationshipId = uuidv5(
      KAATA_UUID_NAMESPACE,
      `discovered-relationship:${vaultId}:${person.account_id}`,
    );
    const archived = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM relationships WHERE user_b_id = ? AND vault_id = ? AND archived_at IS NOT NULL",
      id,
      vaultId,
    );
    current();
    if (archived) throw new TabApiError(409, "contact_archived", "Restore this contact first");
    if (existingPersonId || identities[person.account_id])
      throw new TabInputError("no_relationship");
    await appendPersonAdded({
      userId: id,
      relationshipId,
      name: person.name.trim() || person.username || "Kaata",
      phoneE164: null,
      vaultId,
      shouldContinue: () =>
        getActiveVaultIdSyncMaybe() === vaultId && getAccountIdSync() === session.accountId,
    });
    current();
    return remember();
  });
}
