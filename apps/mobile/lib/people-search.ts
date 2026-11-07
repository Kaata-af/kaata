import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIsFocused } from "expo-router";
import { AppState } from "react-native";
import { getBackendUrl } from "./api";
import { applyForCurrentSession, captureCurrentSession, SessionChangedError } from "./auth";
import {
  getSessionAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  onAccountIdentityChanged,
} from "./db-tx";
import { toAsciiDigits } from "./digits";
import { getCurrentDefaultCountryCode, normalizePhone } from "./phone";
import { getDiscoveredPersonIds } from "./people-connections";

export type DiscoveredPerson = {
  account_id: string;
  name: string;
  username?: string;
  picture_url?: string;
  existing_relationship_id?: string;
};
export type PeopleSearchPage = { people: DiscoveredPerson[]; has_more: boolean };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const EMPTY: DiscoveredPerson[] = [];

/** Names use the same input as local search; phone discovery is exact only. */
export function peopleSearchQuery(input: string, country = getCurrentDefaultCountryCode()): string {
  const query = toAsciiDigits(input).trim().replace(/\s+/g, " ");
  if (Array.from(query).length > 80) return "";
  if (/^[+\d\s().-]+$/.test(query)) {
    if (query.replace(/\D/g, "").length < 7) return "";
    return normalizePhone(query, country) ?? "";
  }
  return Array.from(query.replace(/^@/, "")).length >= 2 ? query : "";
}

export async function searchPeopleDirectory(
  query: string,
  signal: AbortSignal,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<PeopleSearchPage> {
  const session = await captureCurrentSession();
  if (!session.accountId || !session.jwt) throw new SessionChangedError();
  const base = await getBackendUrl();
  await applyForCurrentSession(session, async () => {});
  if (signal.aborted) throw new Error("search_cancelled");
  if (getActiveVaultIdSyncMaybe() !== vaultId) throw new SessionChangedError();
  const path = `${base}/v1/people/search?q=${encodeURIComponent(query)}&include_friends=1`;
  const options = {
    headers: { Authorization: `Bearer ${session.jwt}`, Accept: "application/json" },
    signal,
  };
  let scoped = !!vaultId;
  let response = await fetch(
    `${path}${vaultId ? `&vault_id=${encodeURIComponent(vaultId)}` : ""}`,
    options,
  );
  if (response.status === 404 && vaultId) {
    // A new local book may not exist on the server yet. Discovery still works;
    // only the server's optional existing-contact association is unavailable.
    await applyForCurrentSession(session, async () => {});
    if (signal.aborted || getActiveVaultIdSyncMaybe() !== vaultId) throw new SessionChangedError();
    scoped = false;
    response = await fetch(path, options);
  }
  if (!response.ok) throw new Error("people_search_failed");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as PeopleSearchPage).people))
    throw new Error("people_search_invalid");
  const seen = new Set<string>();
  const people = (data as PeopleSearchPage).people.slice(0, 20).flatMap((person) => {
    if (
      !person ||
      typeof person.account_id !== "string" ||
      !UUID.test(person.account_id) ||
      person.account_id === session.accountId ||
      seen.has(person.account_id) ||
      typeof person.name !== "string" ||
      !person.name.trim()
    )
      return [];
    seen.add(person.account_id);
    return [
      {
        account_id: person.account_id,
        name: person.name.trim(),
        ...(typeof person.username === "string" && person.username
          ? { username: person.username }
          : {}),
        ...(typeof person.picture_url === "string" &&
        person.picture_url.startsWith("https://") &&
        person.picture_url.length <= 2048
          ? { picture_url: person.picture_url }
          : {}),
        ...(scoped &&
        typeof person.existing_relationship_id === "string" &&
        UUID.test(person.existing_relationship_id)
          ? { existing_relationship_id: person.existing_relationship_id }
          : {}),
      },
    ];
  });
  return applyForCurrentSession(session, async () => ({
    people,
    has_more: (data as PeopleSearchPage).has_more === true,
  }));
}

/** No persistent directory cache: clearing search, leaving, or switching accounts discards it. */
export function usePeopleSearch(input: string, enabled: boolean, country?: string) {
  const revision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        revision.current++;
        notify();
      }),
    [],
  );
  const identitySnapshot = useCallback(
    () => `${revision.current}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribe, identitySnapshot, identitySnapshot);
  const account = getSessionAccountIdSync();
  const vault = getActiveVaultIdSyncMaybe();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [attempt, setAttempt] = useState(0);
  const query = peopleSearchQuery(input, country);
  const visible = enabled && focused && foreground && !!query && !!account;
  const scope = JSON.stringify([visible, query, identity, vault, attempt]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [state, setState] = useState<{
    scope: string;
    people: DiscoveredPerson[];
    existingPersonIds: Record<string, string>;
    hasMore: boolean;
    loading: boolean;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!visible) {
      setState(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      alive &&
      latestScope.current === scope &&
      identitySnapshot() === identity &&
      getActiveVaultIdSyncMaybe() === vault;
    setState({
      scope,
      people: EMPTY,
      existingPersonIds: {},
      hasMore: false,
      loading: true,
      error: false,
    });
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), 15_000);
      void Promise.all([
        searchPeopleDirectory(query, controller.signal, vault),
        vault ? getDiscoveredPersonIds(vault).catch(() => ({})) : Promise.resolve({}),
      ])
        .then(async ([page, localIdentities]) => {
          const existingPersonIds: Record<string, string> = { ...localIdentities };
          if (page.people.some((person) => person.existing_relationship_id) && current()) {
            const db = await getDb();
            for (const person of page.people) {
              if (!current()) return;
              if (!person.existing_relationship_id) continue;
              const row = await db.getFirstAsync<{ id: string }>(
                "SELECT user_b_id AS id FROM relationships WHERE id = ? AND vault_id = ? AND archived_at IS NULL",
                person.existing_relationship_id,
                vault,
              );
              if (row) existingPersonIds[person.account_id] = row.id;
            }
          }
          if (current())
            setState({
              scope,
              people: page.people,
              existingPersonIds,
              hasMore: page.has_more,
              loading: false,
              error: false,
            });
        })
        .catch(() => {
          if (current())
            setState({
              scope,
              people: EMPTY,
              existingPersonIds: {},
              hasMore: false,
              loading: false,
              error: true,
            });
        })
        .finally(() => {
          if (timeout) clearTimeout(timeout);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(debounce);
      if (timeout) clearTimeout(timeout);
      controller.abort();
    };
  }, [visible, scope, query, identity, vault]);
  const current = visible && state?.scope === scope ? state : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    visible,
    people: current?.people ?? EMPTY,
    existingPersonIds: current?.existingPersonIds ?? {},
    vaultId: vault,
    loading: visible && (current?.loading ?? true),
    error: current?.error ?? false,
    hasMore: current?.hasMore ?? false,
    retry,
  };
}
