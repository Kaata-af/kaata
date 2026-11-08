import { bytesToHex } from "@noble/hashes/utils";
import { isRunningInExpoGo } from "expo";
import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytesAsync,
  randomUUID,
} from "expo-crypto";
import { fetch } from "expo/fetch";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as SecureStore from "expo-secure-store";
import { openAuthSessionAsync } from "expo-web-browser";
import { Platform } from "react-native";
import { GOOGLE_IOS_CLIENT_ID } from "../constants/env";
import { PersonalCloudProviderError, type PersonalCloudConnection } from "./personal-cloud-types";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ABOUT_URL =
  "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)";
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const UUID = /^[a-f0-9-]{36}$/;

type AndroidDriveAuthorization = {
  connect(): Promise<string | null>;
  getAccessToken(email: string): Promise<string>;
  clearAccessToken(token: string): Promise<void>;
};

type Grant = { driveId: string; email: string; refreshToken?: string };
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
};
let temporaryGrant: { id: string; grant: Grant; accessToken?: string } | undefined;

export class DriveHttpError extends PersonalCloudProviderError {
  constructor(
    public readonly status: number,
    code: PersonalCloudProviderError["code"],
  ) {
    super(code);
  }
}

export async function googleRequest(url: string, options: RequestInit): Promise<Response> {
  if (options.signal) {
    try {
      return await fetch(url, { ...options, credentials: "omit", redirect: "manual" });
    } catch {
      throw new PersonalCloudProviderError("offline");
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, {
      ...options,
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    // These endpoints return small metadata responses. The deadline covers the
    // response body too. Only downloads supply a separate streaming deadline.
    return new Response((await response.text()) || null, {
      status: response.status,
      headers: response.headers,
    });
  } catch {
    throw new PersonalCloudProviderError("offline");
  } finally {
    clearTimeout(timer);
  }
}

export async function driveResponseError(response: Response): Promise<DriveHttpError> {
  const status = response.status;
  if (status === 401) return new DriveHttpError(status, "reconnect");
  if (status === 408 || status === 429 || status >= 500)
    return new DriveHttpError(status, "offline");
  if (status === 403) {
    const details = (await response.json().catch(() => null)) as {
      error?: { errors?: { reason?: string }[]; details?: { reason?: string }[] };
    } | null;
    const reasons = [...(details?.error?.errors ?? []), ...(details?.error?.details ?? [])].map(
      ({ reason }) => reason,
    );
    if (
      reasons.includes("insufficientPermissions") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    ) {
      return new DriveHttpError(status, "reconnect");
    }
    if (reasons.includes("rateLimitExceeded") || reasons.includes("userRateLimitExceeded")) {
      return new DriveHttpError(status, "offline");
    }
  }
  return new DriveHttpError(status, "providerFailed");
}

function iosRedirect(): string | null {
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(GOOGLE_IOS_CLIENT_ID)) return null;
  // The existing iOS Google client already uses this callback URI. The system
  // auth session captures it for this request and leaves GoogleSignin untouched.
  return `${GOOGLE_IOS_CLIENT_ID.split(".").reverse().join(".")}:/oauth2callback`;
}

function androidAuthorization(): AndroidDriveAuthorization | null {
  return requireOptionalNativeModule<AndroidDriveAuthorization>("KaataGoogleDrive");
}

export function supportsGoogleDrive(): boolean {
  if (isRunningInExpoGo()) return false;
  if (Platform.OS === "ios") return iosRedirect() !== null;
  return Platform.OS === "android" && androidAuthorization() !== null;
}

async function exchangeToken(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await googleRequest(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_IOS_CLIENT_ID, ...parameters }).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (data.error === "invalid_grant") throw new PersonalCloudProviderError("reconnect");
  if (!response.ok) {
    throw new PersonalCloudProviderError(
      response.status >= 500 || response.status === 429 ? "offline" : "providerFailed",
    );
  }
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  if (typeof data.scope === "string" && !data.scope.split(" ").includes(DRIVE_SCOPE)) {
    throw new PersonalCloudProviderError("reconnect");
  }
  return data;
}

async function connectOnIos(temporary: boolean): Promise<TokenResponse | null> {
  const redirect = iosRedirect();
  if (!redirect) throw new PersonalCloudProviderError("providerFailed");
  const verifier = bytesToHex(await getRandomBytesAsync(32));
  const state = bytesToHex(await getRandomBytesAsync(24));
  const challenge = await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: CryptoEncoding.BASE64,
  });
  const parameters = new URLSearchParams({
    client_id: GOOGLE_IOS_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: DRIVE_SCOPE,
    code_challenge: challenge.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    code_challenge_method: "S256",
    state,
    ...(temporary
      ? { prompt: "select_account" }
      : { access_type: "offline", prompt: "consent select_account" }),
  });
  const result = await openAuthSessionAsync(
    `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`,
    redirect,
  );
  if (result.type !== "success") return null;
  const callbackPrefix = `${redirect}?`;
  if (!result.url.startsWith(callbackPrefix) || result.url.includes("#")) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  const callback = new URLSearchParams(result.url.slice(callbackPrefix.length));
  if (callback.getAll("state").length !== 1 || callback.get("state") !== state) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  if (callback.get("error") === "access_denied") return null;
  const code = callback.get("code");
  if (!code || callback.getAll("code").length !== 1 || callback.has("error")) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  return exchangeToken({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
}

function androidError(error: unknown): PersonalCloudProviderError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "E_RECONNECT") return new PersonalCloudProviderError("reconnect");
  if (code === "E_OFFLINE") return new PersonalCloudProviderError("offline");
  return new PersonalCloudProviderError("providerFailed");
}

async function driveIdentity(token: string): Promise<Pick<Grant, "driveId" | "email">> {
  const response = await googleRequest(ABOUT_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await driveResponseError(response);
  const data = (await response.json()) as {
    user?: { permissionId?: unknown; emailAddress?: unknown };
  };
  const driveId = data.user?.permissionId;
  const email = data.user?.emailAddress;
  if (typeof driveId !== "string" || !driveId || typeof email !== "string" || !email) {
    throw new PersonalCloudProviderError("providerFailed");
  }
  return { driveId, email };
}

function secureKey(id: string): string {
  if (!UUID.test(id)) throw new PersonalCloudProviderError("reconnect");
  return `kaata.google-drive-backup.${id}`;
}

export async function connectGoogleDrive(options?: {
  temporary?: boolean;
}): Promise<PersonalCloudConnection | null> {
  if (!supportsGoogleDrive()) throw new PersonalCloudProviderError("providerFailed");
  let token: string | null;
  let refreshToken: string | undefined;
  if (Platform.OS === "ios") {
    const result = await connectOnIos(options?.temporary === true);
    if (!result) return null;
    token = result.access_token ?? null;
    refreshToken = result.refresh_token;
    if (!options?.temporary && (typeof refreshToken !== "string" || !refreshToken)) {
      throw new PersonalCloudProviderError("reconnect");
    }
  } else {
    token = await androidAuthorization()!
      .connect()
      .catch((error: unknown) => {
        throw androidError(error);
      });
  }
  if (!token) return null;
  const identity = await driveIdentity(token);
  const id = randomUUID();
  const grant = { ...identity, refreshToken };
  if (options?.temporary)
    temporaryGrant = { id, grant, accessToken: Platform.OS === "ios" ? token : undefined };
  else await SecureStore.setItemAsync(secureKey(id), JSON.stringify(grant), SECURE_OPTIONS);
  return { id, label: identity.email };
}

export async function disconnectGoogleDrive(connection: PersonalCloudConnection): Promise<void> {
  if (temporaryGrant?.id === connection.id) {
    temporaryGrant = undefined;
    return;
  }
  // Google project-wide revocation would also affect other device grants.
  await SecureStore.deleteItemAsync(secureKey(connection.id), SECURE_OPTIONS);
}

async function grantFor(connection: PersonalCloudConnection): Promise<Grant> {
  if (temporaryGrant?.id === connection.id) return temporaryGrant.grant;
  const raw = await SecureStore.getItemAsync(secureKey(connection.id), SECURE_OPTIONS);
  if (!raw) throw new PersonalCloudProviderError("reconnect");
  const grant = JSON.parse(raw) as Partial<Grant>;
  if (typeof grant.driveId !== "string" || typeof grant.email !== "string") {
    throw new PersonalCloudProviderError("reconnect");
  }
  return { driveId: grant.driveId, email: grant.email, refreshToken: grant.refreshToken };
}

export async function withDriveToken<T>(
  connection: PersonalCloudConnection,
  work: (token: string) => Promise<T>,
): Promise<T> {
  const grant = await grantFor(connection);
  const android = Platform.OS === "android" ? androidAuthorization() : null;
  const temporaryToken =
    temporaryGrant?.id === connection.id ? temporaryGrant.accessToken : undefined;
  if (!android && (Platform.OS !== "ios" || (!grant.refreshToken && !temporaryToken))) {
    throw new PersonalCloudProviderError("reconnect");
  }
  async function token(): Promise<string> {
    if (temporaryToken) return temporaryToken;
    if (android) {
      return android.getAccessToken(grant.email).catch((error: unknown) => {
        throw androidError(error);
      });
    }
    const data = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken!,
    });
    return data.access_token!;
  }
  async function run(accessToken: string): Promise<T> {
    const identity = await driveIdentity(accessToken);
    if (identity.driveId !== grant.driveId) throw new PersonalCloudProviderError("reconnect");
    return work(accessToken);
  }
  const accessToken = await token();
  try {
    return await run(accessToken);
  } catch (error) {
    if (!android || !(error instanceof DriveHttpError) || error.status !== 401) throw error;
    await android.clearAccessToken(accessToken).catch((nativeError: unknown) => {
      throw androidError(nativeError);
    });
    return run(await token());
  }
}
