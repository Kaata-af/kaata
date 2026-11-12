import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { peopleRequest } from "./people-connections";
import { notifyPeopleSearchChanged } from "./people-search-events";
import type { DiscoveredPerson } from "./people-search";
import { TabApiError } from "./tabs/errors";

export type FriendState = { state: "none" | "incoming" | "outgoing" | "friends"; id?: string };
export type PersonProfileActivity = {
  shared_tally?: "pending" | "active" | "declined";
  kaata_invitation_role?: "editor" | "clerk" | "viewer";
  kaata_member_role?: "owner" | "manager" | "editor" | "clerk" | "viewer";
  existing_relationship_id?: string;
};
export type PersonProfile = {
  person: DiscoveredPerson;
  friendship: FriendState;
  can_receive_requests: boolean;
  activity?: PersonProfileActivity;
};
export type FriendRequest = { id: string; from: DiscoveredPerson; created_at_ms: number };
export type FriendsPage = { friends: DiscoveredPerson[]; next_cursor?: string };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const isID = (id: unknown): id is string =>
  typeof id === "string" && UUID.test(id) && id !== "00000000-0000-0000-0000-000000000000";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pathID(id: string): string {
  if (!isID(id)) throw new TabApiError(404, "person_unavailable", "Person unavailable");
  return id;
}

function invalidReply(): never {
  throw new TabApiError(502, "invalid_response", "Could not confirm the people response");
}

/** Explicit allowlist: account profile replies are never general account records. */
function parsePerson(value: unknown, withRelationship = false): DiscoveredPerson | null {
  const p = record(value);
  if (!p || !isID(p.account_id) || typeof p.name !== "string") return null;
  return {
    account_id: p.account_id,
    name: p.name.trim(),
    ...(typeof p.username === "string" && p.username ? { username: p.username } : {}),
    ...(typeof p.picture_url === "string" &&
    p.picture_url.startsWith("https://") &&
    p.picture_url.length <= 2048
      ? { picture_url: p.picture_url }
      : {}),
    ...(withRelationship && isID(p.existing_relationship_id)
      ? { existing_relationship_id: p.existing_relationship_id }
      : {}),
  };
}

function parseFriendship(value: unknown): FriendState {
  const f = record(value);
  if (f?.state === "none" && f.id === undefined) return { state: "none" };
  if ((f?.state === "incoming" || f?.state === "outgoing" || f?.state === "friends") && isID(f.id))
    return { state: f.state, id: f.id };
  return invalidReply();
}

function parseActivity(value: unknown): PersonProfileActivity | undefined {
  const a = record(value);
  if (!a) return undefined;
  const tally = a.shared_tally;
  const role = a.kaata_invitation_role;
  const memberRole = a.kaata_member_role;
  return {
    ...(tally === "active" || tally === "pending" || tally === "declined"
      ? { shared_tally: tally }
      : {}),
    ...(role === "editor" || role === "clerk" || role === "viewer"
      ? { kaata_invitation_role: role }
      : {}),
    ...(["owner", "manager", "editor", "clerk", "viewer"].includes(String(memberRole))
      ? { kaata_member_role: memberRole as PersonProfileActivity["kaata_member_role"] }
      : {}),
    ...(isID(a.existing_relationship_id)
      ? { existing_relationship_id: a.existing_relationship_id }
      : {}),
  };
}

export async function getPersonProfile(
  accountId: string,
  session?: SessionSnapshot,
  vaultId?: string,
  beforeDispatch?: () => void,
): Promise<PersonProfile> {
  const id = pathID(accountId);
  const scope = vaultId ? `?vault_id=${pathID(vaultId)}` : "";
  const value = record(
    await peopleRequest<unknown>(
      "GET",
      `/v1/people/profiles/${id}${scope}`,
      undefined,
      session,
      beforeDispatch,
    ),
  );
  const person = parsePerson(value?.person, !!vaultId);
  if (!person || person.account_id !== accountId) return invalidReply();
  const activity = vaultId ? parseActivity(value?.activity) : undefined;
  return {
    person,
    friendship: parseFriendship(value?.friendship),
    can_receive_requests: value?.can_receive_requests === true,
    ...(activity && { activity }),
  };
}

export async function listFriends(after?: string, session?: SessionSnapshot): Promise<FriendsPage> {
  const active = session ?? (await captureCurrentSession());
  const page = record(
    await peopleRequest<unknown>(
      "GET",
      `/v1/friends${after ? `?after=${pathID(after)}` : ""}`,
      undefined,
      active,
    ),
  );
  if (!Array.isArray(page?.friends)) return invalidReply();
  if (page.next_cursor !== undefined && (!isID(page.next_cursor) || page.next_cursor === after))
    return invalidReply();
  const seen = new Set<string>();
  const friends = page.friends.slice(0, 50).flatMap((raw) => {
    const p = parsePerson(raw);
    if (!p || p.account_id === active.accountId || seen.has(p.account_id)) return [];
    seen.add(p.account_id);
    return [p];
  });
  return { friends, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
}

export async function listFriendRequests(
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<FriendRequest[]> {
  const active = session ?? (await captureCurrentSession());
  const value = record(
    await peopleRequest<unknown>("GET", "/v1/friends/requests", undefined, active, beforeDispatch),
  );
  if (!Array.isArray(value?.requests)) return invalidReply();
  const seen = new Set<string>();
  return value.requests.slice(0, 50).flatMap((raw) => {
    const row = record(raw);
    const from = parsePerson(row?.from);
    const created = row?.created_at_ms;
    if (
      !row ||
      !isID(row.id) ||
      seen.has(row.id) ||
      !from ||
      from.account_id === active.accountId ||
      typeof created !== "number" ||
      !Number.isSafeInteger(created) ||
      created <= 0
    )
      return [];
    seen.add(row.id);
    return [{ id: row.id, from, created_at_ms: created }];
  });
}

async function changeFriendship(
  path: string,
  body: unknown,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<FriendState> {
  const reply = record(await peopleRequest<unknown>("POST", path, body, session, beforeDispatch));
  return parseFriendship(reply?.friendship);
}

function notifyFriendshipChanged(session: SessionSnapshot): Promise<void> {
  return applyForCurrentSession(session, async () => {
    if (session.accountId) notifyPeopleSearchChanged({ accountId: session.accountId });
  });
}

export async function sendFriendRequest(
  accountId: string,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<FriendState> {
  const active = session ?? (await captureCurrentSession());
  const result = await changeFriendship(
    "/v1/friends/requests",
    { account_id: pathID(accountId) },
    active,
    beforeDispatch,
  );
  await notifyFriendshipChanged(active);
  return result;
}

export async function acceptFriendRequest(
  id: string,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<FriendState> {
  const active = session ?? (await captureCurrentSession());
  const result = await changeFriendship(
    `/v1/friends/requests/${pathID(id)}/accept`,
    undefined,
    active,
    beforeDispatch,
  );
  if (result.state !== "friends" || result.id !== id) return invalidReply();
  await notifyFriendshipChanged(active);
  return result;
}

export async function dismissFriendRequest(
  id: string,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<void> {
  const active = session ?? (await captureCurrentSession());
  await peopleRequest(
    "DELETE",
    `/v1/friends/requests/${pathID(id)}`,
    undefined,
    active,
    beforeDispatch,
  );
  await notifyFriendshipChanged(active);
}

export async function removeFriend(
  id: string,
  session?: SessionSnapshot,
  beforeDispatch?: () => void,
): Promise<void> {
  const active = session ?? (await captureCurrentSession());
  await peopleRequest("DELETE", `/v1/friends/${pathID(id)}`, undefined, active, beforeDispatch);
  await notifyFriendshipChanged(active);
}
