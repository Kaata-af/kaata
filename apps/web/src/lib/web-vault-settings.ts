import { getWebSession, isSameWebSession, WebApiError, webRequest } from "./web-auth";
import type { WebRole, WebVault } from "./web-ledger";

export type WebVaultMember = {
  account_id: string;
  role: WebRole;
  name?: string;
  email?: string;
};

export type WebVaultSettingsBook = WebVault & { members?: WebVaultMember[] | null };

type AuditEntry = {
  id: number;
  vault_id: string;
  actor_id?: string | null;
  kind: string;
  occurred_at_ms: number;
};

type AuditPage = {
  entries: AuditEntry[];
  next_since_id: number;
  has_more: boolean;
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function vaultPath(vaultID: string): string {
  if (!UUID.test(vaultID)) throw new WebApiError("Invalid kaata.", 400, "invalid_vault");
  return `/v1/vaults/${vaultID}`;
}

export function canRenameWebVault(vault: WebVault): boolean {
  return vault.archived_at_ms == null && (vault.role === "owner" || vault.role === "manager");
}

export function canReadWebVaultAudit(role: WebRole): boolean {
  return role === "owner" || role === "manager" || role === "editor";
}

/** Local-anchor kaatas use the signed ledger operation. */
export async function renameLegacyWebVault(vaultID: string, name: string): Promise<void> {
  const session = getWebSession();
  const result = await webRequest<{ vault_id?: string; name?: string }>(vaultPath(vaultID), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!isSameWebSession(getWebSession(), session)) {
    throw new WebApiError("Your account changed.", 401, "session_expired");
  }
  if (result?.vault_id !== vaultID || result.name !== name) {
    throw new WebApiError("The rename could not be confirmed.", 502, "invalid_response");
  }
}

export async function getWebVaultAudit(
  vaultID: string,
  cursor: number | null,
  signal: AbortSignal,
): Promise<AuditPage> {
  const session = getWebSession();
  const query = new URLSearchParams({ limit: "25" });
  if (cursor !== null) query.set("since_id", String(cursor));
  const page = await webRequest<AuditPage>(`${vaultPath(vaultID)}/audit-log?${query}`, { signal });
  if (!isSameWebSession(getWebSession(), session)) {
    throw new WebApiError("Your account changed.", 401, "session_expired");
  }
  if (
    !Array.isArray(page?.entries) ||
    typeof page.has_more !== "boolean" ||
    page.entries.some(
      (entry, index) =>
        !entry ||
        entry.vault_id !== vaultID ||
        !Number.isSafeInteger(entry.id) ||
        entry.id <= 0 ||
        (cursor !== null && entry.id >= cursor) ||
        (index > 0 && entry.id >= page.entries[index - 1].id) ||
        typeof entry.kind !== "string" ||
        !Number.isSafeInteger(entry.occurred_at_ms) ||
        !Number.isFinite(new Date(entry.occurred_at_ms).getTime()),
    ) ||
    (page.has_more && (!page.entries.length || page.next_since_id !== page.entries.at(-1)?.id))
  ) {
    throw new WebApiError("Activity could not be loaded.", 502, "invalid_response");
  }
  // Audit payloads can contain invite addresses. Render only the summary fields.
  return {
    entries: page.entries.map(({ id, vault_id, actor_id, kind, occurred_at_ms }) => ({
      id,
      vault_id,
      actor_id,
      kind,
      occurred_at_ms,
    })),
    next_since_id: page.next_since_id,
    has_more: page.has_more,
  };
}
