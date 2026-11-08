import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PersonalCloudProviderError, type PersonalCloudProvider } from "../personal-cloud-types";
import { compileUI } from "./ui-fixture";

const TYPES = { PersonalCloudProviderError };
const CLIENT_ID = "fixture.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

async function authorization() {
  const platform = { OS: "android" };
  const records = new Map<string, string>();
  let selected = "alpha";
  let issued = "alpha";
  let serial = 0;
  let badCallback = false;
  let openCount = 0;
  let exchangeCount = 0;
  const auth = compileUI("../google-drive-backup-auth", {
    "@noble/hashes/utils": { bytesToHex },
    expo: { isRunningInExpoGo: () => false },
    "expo-crypto": {
      CryptoDigestAlgorithm: { SHA256: "sha256" },
      CryptoEncoding: { BASE64: "base64" },
      digestStringAsync: async (_algorithm: string, data: string) =>
        createHash("sha256").update(data).digest("base64"),
      getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(7),
      randomUUID: () => `${String(++serial).padStart(8, "0")}-0000-0000-0000-000000000000`,
    },
    "expo/fetch": {
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(init.redirect, "manual");
        if (url === "https://oauth2.googleapis.com/token") {
          exchangeCount++;
          const parameters = new URLSearchParams(String(init.body));
          assert.equal(parameters.get("client_id"), CLIENT_ID);
          if (parameters.get("grant_type") === "authorization_code") {
            assert.match(parameters.get("code_verifier")!, /^[a-f0-9]{64}$/);
            assert.equal(
              parameters.get("redirect_uri"),
              "com.googleusercontent.apps.fixture:/oauth2callback",
            );
          } else {
            assert.equal(parameters.get("refresh_token"), "test-refresh");
          }
          return Response.json({
            access_token: "ios",
            refresh_token: "test-refresh",
            scope: DRIVE_SCOPE,
          });
        }
        assert.match(url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/about\?/);
        const token = new Headers(init.headers).get("Authorization")!.slice(7);
        return Response.json({
          user: { emailAddress: `${token}@example.test`, permissionId: `drive-${token}` },
        });
      },
    },
    "expo-modules-core": {
      requireOptionalNativeModule: () => ({
        connect: async () => selected,
        getAccessToken: async () => issued,
        clearAccessToken: async () => {},
      }),
    },
    "expo-secure-store": {
      setItemAsync: async (key: string, value: string) => records.set(key, value),
      getItemAsync: async (key: string) => records.get(key),
      deleteItemAsync: async (key: string) => records.delete(key),
    },
    "expo-web-browser": {
      openAuthSessionAsync: async (request: string, redirect: string) => {
        openCount++;
        const url = new URL(request);
        assert.equal(url.searchParams.get("scope"), DRIVE_SCOPE);
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("access_type"), "offline");
        const state = url.searchParams.get("state");
        return {
          type: "success",
          url: `${redirect}${badCallback ? "/wrong" : ""}?state=${state}&code=test`,
        };
      },
    },
    "react-native": { Platform: platform },
    "../constants/env": { GOOGLE_IOS_CLIENT_ID: CLIENT_ID },
    "./personal-cloud-types": TYPES,
  });
  const permanent = await auth.connectGoogleDrive();
  selected = "beta";
  const temporary = await auth.connectGoogleDrive({ temporary: true });
  assert.equal(records.size, 1);
  assert.equal(temporary.label, "beta@example.test");
  assert.equal(await auth.withDriveToken(permanent, (token: string) => token), "alpha");
  issued = "beta";
  await assert.rejects(
    auth.withDriveToken(permanent, () => assert.fail("wrong Drive account")),
    { code: "reconnect" },
  );
  assert.equal(await auth.withDriveToken(temporary, (token: string) => token), "beta");
  await auth.disconnectGoogleDrive(permanent);
  assert.equal(records.size, 0);

  platform.OS = "ios";
  badCallback = true;
  await assert.rejects(auth.connectGoogleDrive(), { code: "providerFailed" });
  assert.equal(exchangeCount, 0);
  badCallback = false;
  const ios = await auth.connectGoogleDrive();
  assert.equal(await auth.withDriveToken(ios, (token: string) => token), "ios");
  assert.equal(exchangeCount, 2);
  assert.equal(openCount, 2);
}

async function storage() {
  const scope = "1".repeat(32);
  const device = "2".repeat(32);
  const connection = { id: "test-connection" };
  const target = { scope, device };
  const folder = {
    id: "private-folder",
    mimeType: "application/vnd.google-apps.folder",
    ownedByMe: true,
    shared: false,
    trashed: false,
    appProperties: { kind: "kaata-backup-folder-v1" },
  };
  const content = Uint8Array.of(1, 2, 3);
  const checksum = bytesToHex(sha256(content));
  const location = "https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture";
  const calls: string[] = [];
  let pending: Record<string, unknown> = {};
  let stored: Record<string, unknown> | undefined;
  let interrupted = true;
  let foreignLocation = false;
  let corrupt = false;
  const provider: PersonalCloudProvider = compileUI("../google-drive-backup", {
    "@noble/hashes/sha256": { sha256 },
    "@noble/hashes/utils": { bytesToHex },
    "expo-file-system": { FileMode: { ReadOnly: "r", Truncate: "wt" } },
    "./drive-backup": { DRIVE_BACKUP_FILE_LIMIT: 100 },
    "./personal-cloud-types": TYPES,
    "./google-drive-backup-auth": {
      withDriveToken: async (_connection: unknown, work: (token: string) => Promise<unknown>) =>
        work("access"),
      driveResponseError: async () => new PersonalCloudProviderError("providerFailed"),
      googleRequest: async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        assert.equal(headers.get("Authorization"), "Bearer access");
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://www.googleapis.com");
        if (parsed.searchParams.has("upload_id")) {
          const range = headers.get("Content-Range");
          calls.push(`${init.method} ${range}`);
          if (range === "bytes */3") return new Response(null, { status: 308 });
          if (interrupted) {
            interrupted = false;
            throw new PersonalCloudProviderError("offline");
          }
          stored = {
            ...stored,
            ...pending,
            ownedByMe: true,
            shared: false,
            trashed: false,
            size: "3",
            sha256Checksum: checksum,
          };
          return Response.json(stored);
        }
        if (parsed.pathname.startsWith("/upload/")) {
          calls.push(init.method!);
          pending = JSON.parse(String(init.body));
          return new Response(null, {
            headers: { Location: foreignLocation ? "https://example.test/steal" : location },
          });
        }
        if (parsed.pathname.endsWith("/generateIds")) return Response.json({ ids: ["stable-id"] });
        if (parsed.searchParams.has("q")) {
          const query = parsed.searchParams.get("q")!;
          return Response.json({
            files: query.includes("kaata-backup-folder-v1") ? [folder] : stored ? [stored] : [],
          });
        }
        if (parsed.searchParams.get("alt") === "media") {
          calls.push("download");
          return new Response(corrupt ? Uint8Array.of(1, 2, 4) : content);
        }
        return Response.json(stored);
      },
    },
  }).googleDriveBackupProvider;
  const source = {
    size: 3,
    open: () => ({ readBytes: async () => content.slice(), close() {} }),
  } as unknown as Parameters<PersonalCloudProvider["upload"]>[2];
  let written: Uint8Array | undefined;
  const destination = {
    exists: false,
    create() {
      this.exists = true;
    },
    delete() {
      this.exists = false;
    },
    open: () => ({
      writeBytes: async (value: Uint8Array) => {
        written = value.slice();
      },
      close() {},
    }),
  };
  const file = destination as unknown as typeof source;
  assert.equal((await provider.upload(connection, target, source, 1000)).id, "stable-id");
  assert.deepEqual(calls, ["POST", "PUT bytes 0-2/3", "PUT bytes */3", "PUT bytes 0-2/3"]);
  assert.deepEqual(await provider.list(connection, "3".repeat(32)), []);
  const [original] = await provider.list(connection, scope);
  await provider.upload(connection, target, source, 2000);
  assert.equal(calls[4], "PATCH");
  await assert.rejects(provider.download(connection, scope, original, file), {
    code: "providerFailed",
  });
  assert.ok(!calls.includes("download"));
  const [latest] = await provider.list(connection, scope);
  await provider.download(connection, scope, latest, file);
  assert.deepEqual(written, content);
  corrupt = true;
  await assert.rejects(provider.download(connection, scope, latest, file), {
    code: "providerFailed",
  });
  assert.equal(destination.exists, false);
  foreignLocation = true;
  await assert.rejects(provider.upload(connection, target, source, 3000), {
    code: "providerFailed",
  });
  assert.equal(calls.at(-1), "PATCH");
}

authorization()
  .then(storage)
  .then(() => console.log("google-drive-backup selftest passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
