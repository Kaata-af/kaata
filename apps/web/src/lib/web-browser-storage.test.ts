import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  readWebBrowserValue,
  removeLegacyWebTabValue,
  removeWebBrowserValue,
  writeWebBrowserValue,
} from "./web-browser-storage";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedValues = {
  kaata_web_session_v2: "fixture-kaata-session",
  kaata_web_signing_v1: "fixture-signing-key",
  kaata_web_pending_v1: "fixture-signed-pending-batch",
};

function storage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function browserFixture(
  options: {
    durable?: Map<string, string>;
    disabled?: "access" | "write";
  } = {},
) {
  const durable = options.durable ?? new Map<string, string>();
  const tab = new Map<string, string>();
  let disabled = options.disabled;
  const durableAPI = storage(durable);
  const browser = {
    sessionStorage: storage(tab),
    get localStorage() {
      if (disabled === "access") throw new DOMException("Storage blocked", "SecurityError");
      return {
        ...durableAPI,
        setItem: (key: string, value: string) => {
          if (disabled === "write") throw new DOMException("Storage full", "QuotaExceededError");
          durableAPI.setItem(key, value);
        },
      };
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  return {
    durable,
    tab,
    allowDurable: () => {
      disabled = undefined;
    },
  };
}

after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("the saved session, signing identity and pending batch survive closing a tab", () => {
  const first = browserFixture();
  for (const [key, value] of Object.entries(savedValues)) {
    writeWebBrowserValue(key, value);
    first.tab.set(key, "obsolete-tab-copy");
  }
  assert.deepEqual(Object.fromEntries(first.durable), savedValues);
  first.tab.clear();
  browserFixture({ durable: first.durable });
  for (const [key, value] of Object.entries(savedValues))
    assert.equal(readWebBrowserValue(key), value);
  removeWebBrowserValue("kaata_web_pending_v1");
  assert.equal(readWebBrowserValue("kaata_web_pending_v1"), null);
  assert.equal(readWebBrowserValue("kaata_web_session_v2"), savedValues.kaata_web_session_v2);
});

test("legacy tab cleanup removes only the obsolete copy when durable storage is active", () => {
  const f = browserFixture();
  for (const [key, value] of Object.entries(savedValues)) {
    f.tab.set(key, "obsolete-tab-copy");
    writeWebBrowserValue(key, value);
    removeLegacyWebTabValue(key);
    assert.equal(f.tab.has(key), false);
    assert.equal(readWebBrowserValue(key), value);
  }
});

test("disabled persistent storage uses one tab fallback for credentials, keys and pending writes", () => {
  for (const disabled of ["access", "write"] as const) {
    const f = browserFixture({ disabled });
    for (const [key, value] of Object.entries(savedValues)) writeWebBrowserValue(key, value);
    assert.deepEqual(Object.fromEntries(f.tab), savedValues);
    assert.equal(f.durable.size, 0);

    // Enabling local storage midway through a tab must not split the saved
    // credential from the signing key or pending batch selected earlier.
    f.allowDurable();
    for (const [key, value] of Object.entries(savedValues)) {
      assert.equal(readWebBrowserValue(key), value);
      removeLegacyWebTabValue(key);
      assert.equal(readWebBrowserValue(key), value, "migration preserves the active fallback");
    }
    writeWebBrowserValue("kaata_web_pending_v1", "next-signed-batch");
    assert.equal(f.tab.get("kaata_web_pending_v1"), "next-signed-batch");
    assert.equal(f.durable.size, 0);
    removeWebBrowserValue("kaata_web_pending_v1");
    assert.equal(f.tab.has("kaata_web_pending_v1"), false);
    assert.equal(readWebBrowserValue("kaata_web_signing_v1"), savedValues.kaata_web_signing_v1);
  }
});
