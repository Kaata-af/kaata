// Unknown backends ignore optional currency fields. Keep records queued until
// the server explicitly confirms it understands separate currency balances.
const supported = new Map<string, number>();
export const CURRENCY_SYNC_HEADERS = {
  "X-Kaata-Currencies": "1",
  "X-Kaata-Entry-Currency-Edit": "1",
} as const;

/** Compare frozen legacy denominations before sending/receiving old untagged
 * history. A fresh recovery has no local row yet and learns it from metadata. */
export async function currencyRequestHeaders(
  db: Pick<import("./db-tx").SQLiteTx, "getFirstAsync">,
  vaultId: string,
): Promise<Record<string, string>> {
  const row = await db.getFirstAsync<{ legacy_currency: string | null }>(
    "SELECT legacy_currency FROM vaults WHERE id=?",
    vaultId,
  );
  return {
    ...CURRENCY_SYNC_HEADERS,
    ...(row?.legacy_currency ? { "X-Kaata-Legacy-Currency": row.legacy_currency } : {}),
  };
}

export async function ensureCurrencySyncSupported(
  baseUrl: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Currency sync cancelled");
  if ((supported.get(baseUrl) ?? 0) > Date.now()) return;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 6000);
  try {
    const response = await fetch(`${baseUrl}/v1/sync/capabilities`, {
      headers: { ...CURRENCY_SYNC_HEADERS, Authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    const body = response.ok ? await response.json() : null;
    if (body?.multi_currency !== true)
      throw new Error("This server needs an update before currencies can sync");
    supported.set(baseUrl, Date.now() + 300_000);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/** A multi-currency server may predate contact defaults. Probe this separate
 * capability for each queued change, so an older deployment keeps it local. */
export async function supportsPersonDefaultCurrencySync(
  baseUrl: string,
  jwt: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${baseUrl}/v1/sync/capabilities`, {
      headers: { ...CURRENCY_SYNC_HEADERS, Authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    const body = response.ok ? await response.json() : null;
    return body?.person_default_currency === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Never submit a signed currency edit to a server that still treats the unit
 * as immutable. Leave it and all later dependent writes queued unchanged. */
export async function supportsEntryCurrencyEditSync(
  baseUrl: string,
  jwt: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${baseUrl}/v1/sync/capabilities`, {
      headers: { ...CURRENCY_SYNC_HEADERS, Authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    const body = response.ok ? await response.json() : null;
    return body?.multi_currency === true && body?.entry_currency_edit === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
