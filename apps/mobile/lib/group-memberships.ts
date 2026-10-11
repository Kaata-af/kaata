/** One LWW register holds the complete set. The first ID mirrors old clients. */
export const MAX_CUSTOMER_GROUP_MEMBERSHIPS = 100;

export function canonicalGroupIds(input: readonly string[]): string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_CUSTOMER_GROUP_MEMBERSHIPS ||
    input.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)
  )
    throw new Error("invalid group ids");
  return [...new Set(input)].sort();
}

export function groupIdsFromPayload(payload: {
  group_id: string | null;
  group_ids?: readonly string[];
}): string[] {
  if (payload.group_id !== null && typeof payload.group_id !== "string")
    throw new Error("invalid group id");
  if (payload.group_ids === undefined)
    return canonicalGroupIds(payload.group_id === null ? [] : [payload.group_id]);
  const ids = canonicalGroupIds(payload.group_ids);
  if ((ids[0] ?? null) !== payload.group_id) throw new Error("group id mirror mismatch");
  return ids;
}

export function storedGroupIds(raw: string | null, legacy: string | null): string[] {
  if (raw == null) return canonicalGroupIds(legacy === null ? [] : [legacy]);
  return canonicalGroupIds(JSON.parse(raw));
}
