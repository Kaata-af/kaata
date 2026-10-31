// Browser credentials, signing identity and unconfirmed writes must have the
// same lifetime. Prefer durable origin-scoped storage, with a consistent
// tab-only fallback when the browser disables persistent storage.
const stores = new WeakMap<Window, Storage>();

function browserStorage(): Storage {
  const cached = stores.get(window);
  if (cached) return cached;
  let storage: Storage;
  try {
    storage = window.localStorage;
    const probe = "kaata_web_storage_check";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch {
    storage = window.sessionStorage;
  }
  stores.set(window, storage);
  return storage;
}

export function readWebBrowserValue(key: string): string | null {
  return browserStorage().getItem(key);
}

export function writeWebBrowserValue(key: string, value: string): void {
  browserStorage().setItem(key, value);
}

export function removeWebBrowserValue(key: string): void {
  browserStorage().removeItem(key);
}

export function removeLegacyWebTabValue(key: string): void {
  // In fallback mode these are still the live signing/retry values.
  if (browserStorage() !== window.sessionStorage) window.sessionStorage.removeItem(key);
}
