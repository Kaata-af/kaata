import { BACKEND_URL } from "../env";
import type { Lang } from "./language";
import { parseSharedLedger, type MultiCurrencyBill, type SharedEntry } from "./shared-ledger";
import { getWebSession, isSameWebSession, type WebSession } from "./web-auth";
import { getWebLedger, type WebLedger, type WebPerson } from "./web-ledger";
import { webAmountMinor } from "./web-ledger-protocol";

export class WebBillError extends Error {
  constructor(public code: "unavailable" | "invalid" | "stale" | "publish_failed") {
    super(code);
  }
}

export function canPreviewWebBill(person: WebPerson): boolean {
  // Web's private projection omits previously linked accounts and their evidence.
  return person.read_only_reason !== "shared_tab" && person.shared == null;
}

function majorUnits(minor: bigint): number {
  const exactMinor = Number(minor);
  const amount = exactMinor / 100;
  if (
    !Number.isSafeInteger(exactMinor) ||
    Math.round(amount * 100) !== exactMinor ||
    webAmountMinor(String(Math.abs(amount))) !== Math.abs(exactMinor)
  )
    throw new WebBillError("invalid");
  return amount;
}

export function buildWebBill(
  ledger: WebLedger,
  personID: string,
  locale: Lang,
  generatedAt = Date.now(),
): MultiCurrencyBill {
  const person = ledger.people.find((row) => row.relationship_id === personID);
  if (!person || !canPreviewWebBill(person)) throw new WebBillError("unavailable");
  const entries = ledger.entries
    .filter(
      (entry) =>
        entry.relationship_id === personID && !entry.is_deleted && entry.disputed_at == null,
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  if (entries.length > 5000) throw new WebBillError("invalid");

  const currencies = new Map<
    string,
    { balance: bigint; entries: SharedEntry[]; boundaries: Set<number> }
  >();
  for (const entry of entries) {
    let section = currencies.get(entry.currency);
    if (!section) {
      section = { balance: 0n, entries: [], boundaries: new Set() };
      currencies.set(entry.currency, section);
    }
    let minor: bigint;
    try {
      minor = BigInt(webAmountMinor(entry.amount_afn));
    } catch {
      throw new WebBillError("invalid");
    }
    section.balance += entry.type === "debt" ? minor : -minor;
    section.entries.push({
      currency: entry.currency,
      type: entry.type,
      amount: majorUnits(minor),
      note: entry.note,
      date: entry.created_at,
      recorded_at_ms: entry.recorded_at_ms ?? entry.created_at,
    });
    if (entry.settled_at != null) section.boundaries.add(entry.settled_at);
  }

  const fallback = person.default_entry_currency ?? ledger.default_entry_currency;
  if (!currencies.size)
    currencies.set(fallback, { balance: 0n, entries: [], boundaries: new Set() });
  const codes = [...currencies.keys()].sort((a, b) =>
    a === fallback ? -1 : b === fallback ? 1 : a.localeCompare(b),
  );
  const bill: MultiCurrencyBill = {
    v: 2,
    shop: ledger.name,
    person: person.name,
    locale,
    calendar: locale === "en" ? "gregorian" : "jalali",
    generated_at: generatedAt,
    currencies: codes.map((code) => {
      const { balance, entries, boundaries } = currencies.get(code)!;
      const latest = person.settled_through?.[code] ?? null;
      if (latest != null) boundaries.add(latest);
      return {
        currency: code,
        currency_code: code,
        balance: majorUnits(balance),
        entries,
        settled_boundary_ms: latest,
        settled_chapters: boundaries.size,
        settled_boundaries: [...boundaries].sort((a, b) => a - b),
      };
    }),
  };
  if (!parseSharedLedger(bill)) throw new WebBillError("invalid");
  return bill;
}

function billURL(response: unknown): string {
  const { url, token, bill_version } = (response ?? {}) as Record<string, unknown>;
  if (
    bill_version !== 2 ||
    typeof url !== "string" ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(token)
  )
    throw new WebBillError("publish_failed");
  const parsed = new URL(url);
  const kaataHost = ["kaata.af", "www.kaata.af", "api.kaata.af", "bill.kaata.af"].includes(
    parsed.hostname,
  );
  const trustedOrigin =
    ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === new URL(BACKEND_URL).origin) ||
    (parsed.protocol === "https:" && kaataHost && !parsed.port);
  if (
    !trustedOrigin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/v2/${token}`
  )
    throw new WebBillError("publish_failed");
  return parsed.href;
}

export async function createWebBillLink(
  session: WebSession,
  vaultID: string,
  personID: string,
  locale: Lang,
  reviewed: MultiCurrencyBill,
  signal: AbortSignal,
): Promise<string> {
  function ensureCurrent() {
    signal.throwIfAborted();
    if (!isSameWebSession(getWebSession(), session)) throw new WebBillError("unavailable");
  }

  ensureCurrent();
  const url = `${BACKEND_URL.replace(/\/$/, "")}/v1/shared`;
  const options: RequestInit = {
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  };
  const capability = await fetch(`${url}/capabilities`, options);
  if (!capability.ok) throw new WebBillError("publish_failed");
  const supported = (await capability.json()) as { bill_versions?: unknown } | null;
  if (!Array.isArray(supported?.bill_versions) || !supported.bill_versions.includes(2))
    throw new WebBillError("publish_failed");

  // The public upload has no membership check. Re-read the private ledger before
  // sending and confirm that the exact payload the user reviewed is still current.
  ensureCurrent();
  const ledger = await getWebLedger(vaultID);
  ensureCurrent();
  if (ledger.vault_id !== vaultID || ledger.bill_links_enabled !== true)
    throw new WebBillError("unavailable");
  const snapshot = buildWebBill(ledger, personID, locale, reviewed.generated_at);
  const body = JSON.stringify(snapshot);
  if (body !== JSON.stringify(reviewed)) throw new WebBillError("stale");
  if (new TextEncoder().encode(body).length > 4 * 1024 * 1024) throw new WebBillError("invalid");

  const response = await fetch(url, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new WebBillError("publish_failed");
  const result = await response.json();
  ensureCurrent();
  return billURL(result);
}
