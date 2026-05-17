import * as Crypto from "expo-crypto";
import { getAppMeta, setAppMeta } from "./db";

export async function ensureInstallId(): Promise<string> {
  const existing = await getAppMeta("install_id");
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await setAppMeta("install_id", id);
  return id;
}
