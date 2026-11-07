import { BACKEND_URL } from "../../env";
import { AuthError } from "./api";

export const ADMIN_PRO_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20_000;

export function adminProTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export async function adminProRequest(
  token: string,
  accountID: string,
  init: RequestInit = {},
  suffix = "",
) {
  if (!ADMIN_PRO_UUID.test(accountID)) throw new Error("Invalid account ID.");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
  if (init.body) headers.set("Content-Type", "application/json");
  const path = `/v1/admin/users/${accountID}/pro${suffix}`;
  const response = await fetch(`${BACKEND_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (response.status === 401) throw new AuthError();
  return response;
}
