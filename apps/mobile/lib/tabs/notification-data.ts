// Push identifiers are navigation hints, not authority. Shared with tests.
export const TAB_ACCEPT = "tab-accept";
export const TAB_REJECT = "tab-reject";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseTabReview(action: string, data: unknown) {
  if (action !== TAB_ACCEPT && action !== TAB_REJECT) return null;
  if (!data || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  if (
    p.kind !== "entry_created" ||
    typeof p.tab_id !== "string" ||
    !UUID.test(p.tab_id) ||
    typeof p.entry_id !== "string" ||
    !UUID.test(p.entry_id) ||
    typeof p.rev !== "number" ||
    !Number.isSafeInteger(p.rev) ||
    p.rev <= 0 ||
    (p.role !== "a" && p.role !== "b")
  )
    return null;
  return {
    tabId: p.tab_id,
    entryId: p.entry_id,
    rev: p.rev,
    role: p.role,
    action: action === TAB_ACCEPT ? ("accept" as const) : ("dispute" as const),
  };
}
