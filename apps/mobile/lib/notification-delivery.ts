import { getAppMeta, setAppMeta } from "./db";
import { getSessionAccountIdSync } from "./db-tx";

let deliveryTail: Promise<unknown> = Promise.resolve();
export async function notificationWasDelivered(account: string, key: string): Promise<boolean> {
  await deliveryTail;
  try {
    const values = JSON.parse((await getAppMeta(`notification_delivered_v1:${account}`)) ?? "[]");
    return Array.isArray(values) && values.includes(key);
  } catch {
    return false;
  }
}
/** Push, polling and local fallback race through one durable receipt. This
 * survives a JS restart and keeps provider retries from chiming again. */
export function claimNotificationDelivery(
  account: string,
  key: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const work = async () => {
    const current = () => getSessionAccountIdSync() === account && isCurrent();
    if (!current()) return false;
    const meta = `notification_delivered_v1:${account}`;
    let keys: string[] = [];
    try {
      const value = JSON.parse((await getAppMeta(meta)) ?? "[]");
      if (Array.isArray(value)) keys = value.filter((x): x is string => typeof x === "string");
    } catch {
      /* Invalid receipt cache establishes a new bounded history. */
    }
    if (!current() || keys.includes(key)) return false;
    await setAppMeta(meta, JSON.stringify([...keys.slice(-255), key]));
    return current();
  };
  const next = deliveryTail.then(work, work);
  deliveryTail = next.catch(() => undefined);
  return next;
}
