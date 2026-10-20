// Synthetic native/network fixtures only: no real phone identifiers or backend.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Helper = typeof import("../device-estimate");
type Estimate = import("../device-estimate").DeviceEstimate;
type Api = typeof import("../api");

function load<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected dependency of ${path}: ${name}`);
    return mocks[name];
  }, exports);
  return exports as T;
}

const ANDROID_ID = "1234abcd5678ef90";
const IOS_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const expected = (kind: Estimate["device_id_kind"], id: string): Estimate => ({
  device_id_kind: kind,
  device_id_hash: digest(`kaata-device:v1:${kind}:${id}`),
});

function fixture(platform = "android", expoGo = false) {
  let value: unknown = platform === "android" ? ANDROID_ID : IOS_ID;
  let nativeError = false;
  let hashError = false;
  let nativeGate: Promise<unknown> | null = null;
  let hashGate: Promise<string> | null = null;
  let reads = 0;
  const inputs: string[] = [];
  const read = () => {
    reads++;
    if (nativeError) throw new Error("synthetic unavailable identifier");
    return value;
  };
  const mocks = {
    "react-native": { Platform: { OS: platform } },
    "./expo-go": { IS_EXPO_GO: expoGo },
    "expo-application": {
      getAndroidId: read,
      getIosIdForVendorAsync: async () => (nativeGate ? nativeGate : read()),
    },
    "expo-crypto": {
      CryptoDigestAlgorithm: { SHA256: "sha256" },
      digestStringAsync: async (algorithm: string, text: string) => {
        assert.equal(algorithm, "sha256");
        inputs.push(text);
        if (hashError) throw new Error("synthetic hash failure");
        return hashGate ?? digest(text);
      },
    },
  };
  return {
    helper: load<Helper>("../device-estimate", mocks),
    reload: () => load<Helper>("../device-estimate", mocks),
    setValue: (next: unknown) => {
      value = next;
    },
    setNativeError: (next: boolean) => {
      nativeError = next;
    },
    setHashError: (next: boolean) => {
      hashError = next;
    },
    setNativeGate: (next: Promise<unknown> | null) => {
      nativeGate = next;
    },
    setHashGate: (next: Promise<string> | null) => {
      hashGate = next;
    },
    inputs,
    reads: () => reads,
  };
}

let cases = 0;
async function check(name: string, run: () => void | Promise<void>) {
  await run();
  cases++;
  console.log(`  ok  ${name}`);
}

async function main() {
  await check(
    "Android normalizes, uses SHA-256 domain separation, and remains stable after data reset",
    async () => {
      const phone = fixture();
      phone.setValue(` ${ANDROID_ID.toUpperCase()} `);
      const first = await phone.helper.getDeviceEstimate();
      assert.deepEqual(first, expected("android_id", ANDROID_ID));
      assert.deepEqual(await phone.helper.getDeviceEstimate(), first);
      assert.deepEqual(await phone.reload().getDeviceEstimate(), first);
      assert.deepEqual(phone.inputs, Array(3).fill(`kaata-device:v1:android_id:${ANDROID_ID}`));
      assert.match(first!.device_id_hash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(first).includes(ANDROID_ID));
    },
  );

  await check("iOS canonicalizes IDFV and uses its own identifier domain", async () => {
    const phone = fixture("ios");
    phone.setValue(` ${IOS_ID.toUpperCase()} `);
    const first = await phone.helper.getDeviceEstimate();
    assert.deepEqual(first, expected("ios_idfv", IOS_ID));
    assert.deepEqual(await phone.reload().getDeviceEstimate(), first);
    assert.equal(phone.inputs[0], `kaata-device:v1:ios_idfv:${IOS_ID}`);
    assert.notEqual(first!.device_id_hash, digest(`kaata-device:v1:android_id:${IOS_ID}`));
  });

  await check("Android 7 unpadded IDs match the same 64-bit padded identifier", async () => {
    const phone = fixture();
    for (const short of ["123456789abcdef", "1"]) {
      phone.setValue(short);
      const unpadded = await phone.helper.getDeviceEstimate();
      const padded = short.padStart(16, "0");
      assert.deepEqual(unpadded, expected("android_id", padded));
      phone.setValue(padded);
      assert.deepEqual(await phone.helper.getDeviceEstimate(), unpadded);
    }
  });

  await check(
    "invalid Android IDs and known shared placeholders never become devices",
    async () => {
      const phone = fixture();
      for (const value of [
        null,
        undefined,
        "",
        123,
        "not-hex",
        "0123456789abcdef0",
        "0123456789abcdeg",
        "0",
        "000",
        "0000000000000000",
        "ffffffffffffffff",
        "9774D56D682E549C",
      ]) {
        phone.setValue(value);
        assert.equal(await phone.helper.getDeviceEstimate(), null, String(value));
      }
      assert.deepEqual(phone.inputs, []);
      phone.setValue(ANDROID_ID);
      assert.deepEqual(await phone.helper.getDeviceEstimate(), expected("android_id", ANDROID_ID));
    },
  );

  await check("null, zero, and malformed IDFVs retry on later check-in", async () => {
    const phone = fixture("ios");
    for (const value of [
      null,
      undefined,
      "",
      123,
      "00000000-0000-0000-0000-000000000000",
      IOS_ID.replaceAll("-", ""),
      `{${IOS_ID}}`,
      "abcdef12-3456-7890-abcd-ef123456789g",
    ]) {
      phone.setValue(value);
      assert.equal(await phone.helper.getDeviceEstimate(), null, String(value));
    }
    assert.deepEqual(phone.inputs, []);
    phone.setValue(IOS_ID);
    assert.deepEqual(await phone.helper.getDeviceEstimate(), expected("ios_idfv", IOS_ID));
  });

  await check("native errors and hash errors stay optional and are never cached", async () => {
    for (const platform of ["android", "ios"]) {
      const phone = fixture(platform);
      phone.setNativeError(true);
      assert.equal(await phone.helper.getDeviceEstimate(), null);
      phone.setNativeError(false);
      phone.setHashError(true);
      assert.equal(await phone.helper.getDeviceEstimate(), null);
      phone.setHashError(false);
      assert.deepEqual(
        await phone.helper.getDeviceEstimate(),
        platform === "android" ? expected("android_id", ANDROID_ID) : expected("ios_idfv", IOS_ID),
      );
    }
  });

  await check("Expo Go and unsupported platforms never read the OS identifier", async () => {
    for (const phone of [
      fixture("android", true),
      fixture("ios", true),
      fixture("web"),
      fixture("windows"),
    ]) {
      assert.equal(await phone.helper.getDeviceEstimate(), null);
      assert.equal(phone.reads(), 0);
      assert.deepEqual(phone.inputs, []);
    }
  });

  await check("a hung native lookup or digest has a short deadline and retries later", async () => {
    const native = fixture("ios");
    const hashing = fixture();
    native.setNativeGate(new Promise(() => {}));
    hashing.setHashGate(new Promise(() => {}));
    const started = Date.now();
    assert.deepEqual(
      await Promise.all([native.helper.getDeviceEstimate(), hashing.helper.getDeviceEstimate()]),
      [null, null],
    );
    assert.ok(
      Date.now() - started < 2000,
      "optional lookup must not wait for the 5-second request timeout",
    );
    native.setNativeGate(null);
    hashing.setHashGate(null);
    assert.deepEqual(await native.helper.getDeviceEstimate(), expected("ios_idfv", IOS_ID));
    assert.deepEqual(await hashing.helper.getDeviceEstimate(), expected("android_id", ANDROID_ID));
  });

  await check(
    "check-in adds only hashed metadata and keeps caller installation/session values",
    async () => {
      const oldFetch = globalThis.fetch;
      const requests: {
        body: Record<string, unknown>;
        headers: Record<string, string>;
        signal: AbortSignal | null | undefined;
      }[] = [];
      let metadata: Estimate | null = expected("android_id", ANDROID_ID);
      const api = load<Api>("../api", {
        "../constants/env": { BACKEND_URL_FALLBACK: "https://backend.invalid" },
        "./auth": { getSessionJWT: async () => "session.fixture", InstallRetiredError: Error },
        "./db": { getAppMeta: async () => null },
        "./device-estimate": { getDeviceEstimate: async () => metadata },
        "./install-id": { clearInstallRetired: async () => {}, markInstallRetired: async () => {} },
      });
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        requests.push({
          body: JSON.parse(init!.body as string),
          headers: init!.headers as Record<string, string>,
          signal: init?.signal,
        });
        return new Response(JSON.stringify({ server_time: "2026-10-20T00:00:00Z" }), {
          status: 200,
        });
      }) as typeof fetch;
      try {
        const payload = {
          install_id: "installation-before-reset",
          app_version: "2.2.0",
          platform: "android",
          device_locale: "en-US",
          usage_entries_created: 3,
          device_id_hash: "caller-cannot-override",
          device_id_kind: "caller-cannot-override",
        };
        await api.checkIn(payload);
        assert.equal(requests[0].body.install_id, payload.install_id);
        assert.equal(requests[0].body.usage_entries_created, 3);
        assert.equal(requests[0].headers.Authorization, "Bearer session.fixture");
        assert.ok(requests[0].signal instanceof AbortSignal);
        assert.deepEqual(
          {
            device_id_hash: requests[0].body.device_id_hash,
            device_id_kind: requests[0].body.device_id_kind,
          },
          metadata,
        );
        assert.ok(!JSON.stringify(requests).includes(ANDROID_ID));
        assert.equal(
          payload.device_id_hash,
          "caller-cannot-override",
          "callers' payloads are not mutated",
        );
        metadata = null;
        await api.checkIn({ ...payload, install_id: "installation-after-reset" });
        assert.equal(requests[1].body.install_id, "installation-after-reset");
        assert.ok(!("device_id_hash" in requests[1].body));
        assert.ok(!("device_id_kind" in requests[1].body));
      } finally {
        globalThis.fetch = oldFetch;
      }
    },
  );

  console.log(`\ndevice-estimate selftest: ${cases} cases passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
