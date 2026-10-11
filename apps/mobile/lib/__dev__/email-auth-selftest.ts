// Run with: npm run selftest:email-auth
// Synthetic fixtures only: never opens kaata.db, SecureStore, a device or the
// network.
//
// Kaata's own accounts, email + password (docs/kaata-accounts.md). This pins
// the phone's half against the ACTUAL lib/auth.ts, lib/account-rules.ts,
// lib/install-id.ts, lib/i18n.ts, components/EmailAuthFlow.tsx,
// components/PasswordField.tsx and app/onboarding/auth.tsx, transpiled with
// mocks in the install-retired-selftest.ts pattern; app_meta and the ledger
// tables sign-in touches are real SQL on an in-memory better-sqlite3 database:
//   - every email endpoint's request and reply, and every refusal as a typed
//     EmailAuthError whose message carries nothing the user typed;
//   - 429s: the per-address throttle (too_many_requests + limit), where only a
//     RETRIED start answered by the "minute" window counts as sent; the per-IP
//     limiter (no error_code, Retry-After in SECONDS, a timestamp ignored);
//   - "different account on this phone?" decided by the server (409
//     different_account) for email AND Google: keep resends with allow_switch,
//     wipe resends under a fresh install id without current_account_id,
//     cancel stops; and when the question is not asked at all;
//   - the retry fallback: a verify whose reply was lost, answered invalid_code
//     or account_exists, is settled by a password sign-in first;
//   - the pending code step ({purpose, email, sent_at}, 15 minutes) and the
//     account-name hand-off an email account needs;
//   - the client mirrors of the server's rules, and copy for every error_code;
//   - EmailAuthFlow's steps, rendered with a hook-slot React stub, and the
//     sign-in screen's email mode.
// Not covered: real keyboards and focus, mail delivery, the backend itself.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";

type Auth = typeof import("../auth");
type Rules = typeof import("../account-rules");
type I18n = typeof import("../i18n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = { type: unknown; props: Record<string, any> };

const BASE = "https://backend.invalid";
const SESSION_KEY = "kaata.session.jwt";
const USER_KEY = "kaata.session.user";
const PENDING_KEY = "email_flow_pending";
const DAY_MS = 24 * 60 * 60 * 1000;

// Transpile one real module and evaluate it against `mocks`. Anything it
// requires that is not mocked fails loudly, so a new dependency is noticed.
function load<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected dependency of ${path}: ${name}`);
    return mocks[name];
  }, exports);
  return exports as T;
}

const settle = () => new Promise<void>((done) => setImmediate(done));

// Fire-and-forget chains (the account-name hand-off) finish on their own time.
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await settle();
  assert.ok(done(), `never happened: ${what}`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

// --- the phone: real SQL ------------------------------------------------------

const fixture = new Database(":memory:");
const sqlite = {
  execAsync: async (sql: string) => {
    fixture.exec(sql);
  },
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  withTransactionAsync: async (work: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await work();
      fixture.exec("COMMIT");
    } catch (err) {
      fixture.exec("ROLLBACK");
      throw err;
    }
  },
};

function metaGet(key: string): string | null {
  const row = fixture.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function metaSet(key: string, value: string): void {
  fixture
    .prepare(
      "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// The ledger tables a sign-in reads or writes, empty.
const LEDGER = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT, phone_e164 TEXT,
    is_local_self INTEGER, account_id TEXT, google_sub TEXT, updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, account_id TEXT, name TEXT,
    currency TEXT, created_at INTEGER, registered_with_server_at INTEGER, updated_at INTEGER,
    vault_trust_anchor_pubkey TEXT);
  CREATE TABLE IF NOT EXISTS vault_members_mirror (vault_id TEXT, account_id TEXT, role TEXT,
    accepted_at INTEGER, revoked_at INTEGER, PRIMARY KEY (vault_id, account_id));
  CREATE TABLE IF NOT EXISTS event_log (event_id TEXT, vault_id TEXT, hlc_physical_ms INTEGER,
    hlc_logical INTEGER, hlc_device_id TEXT);`;

// --- native and network boundaries ---------------------------------------------

const secure = new Map<string, string>();
const trace: string[] = [];
let accountCache: string | null = null;
let accountCacheReadHook: (() => string | null) | null = null;

type Call = {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  auth: string | null;
};
const calls: Call[] = [];
// One responder per expected request, in order. An unscripted request fails the case.
let script: Array<(call: Call) => Response | Promise<Response>> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call: Call = {
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    auth: new Headers(init?.headers).get("Authorization"),
  };
  calls.push(call);
  const next = script.shift();
  if (!next) throw new Error(`unscripted request: ${call.method} ${call.url}`);
  return next(call);
}) as typeof fetch;

const reply = (status: number, body: unknown, headers?: Record<string, string>) => () =>
  new Response(JSON.stringify(body), { status, headers });
// A request that never got an answer: the phone cannot know whether it landed.
const lost = () => {
  throw new TypeError("Network request failed");
};

// What the server answers to a sign-in (docs/kaata-accounts.md §6). An email
// session carries no user.sub.
const session = (account: string, email: string, user: Record<string, unknown> = {}) => ({
  session_jwt: `jwt.${account}`,
  account_id: account,
  default_vault_id: null,
  user: { email, name: "Account Name", has_password: true, ...user },
});

let googleResult: unknown = { type: "success", data: { idToken: "google.id.token" } };
let googleSignIns = 0;
let googleSignOuts = 0;
let appleIdentityToken = "apple.id.token";
const reactNative = { Platform: { OS: "android" } };

// A JWT-shaped token with these claims (unsigned: the phone never verifies one).
const jwtWith = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.sig`;
const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;

// A fresh install: an install id, an empty ledger, nothing signed in.
function freshPhone(): string {
  fixture.exec(`DROP TABLE IF EXISTS app_meta; DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS vaults; DROP TABLE IF EXISTS vault_members_mirror;
    DROP TABLE IF EXISTS event_log;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${LEDGER}`);
  const id = randomUUID();
  metaSet("install_id", id);
  secure.clear();
  calls.length = 0;
  script = [];
  trace.length = 0;
  accountCache = null;
  accountCacheReadHook = null;
  googleSignIns = 0;
  googleSignOuts = 0;
  googleResult = { type: "success", data: { idToken: "google.id.token" } };
  appleIdentityToken = "apple.id.token";
  return id;
}

// A phone whose ledger (one person: the shopkeeper) is bound to `account`,
// active `idleMs` ago.
function boundPhone(account = "acct-old", idleMs = 60_000): string {
  const id = freshPhone();
  metaSet("account_id", account);
  metaSet("account_last_seen_at", String(Date.now() - idleMs));
  metaSet("account_display_email", "old@example.com");
  fixture
    .prepare(
      "INSERT INTO users (id, display_name, is_local_self) VALUES ('self', 'Matee Saafi', 1)",
    )
    .run();
  return id;
}

function signedIn(jwt = "jwt.current"): void {
  secure.set(SESSION_KEY, jwt);
}

// --- the real modules ----------------------------------------------------------

const installId = load<typeof import("../install-id")>("../install-id", {
  "expo-crypto": { randomUUID },
  "./db": {
    getAppMeta: async (key: string) => metaGet(key),
    setAppMeta: async (key: string, value: string) => metaSet(key, value),
  },
  "./db-tx": { getDb: async () => sqlite },
});

const i18n = load<I18n>("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en", languageTag: "en-US" }] },
  "./db": { getAppMeta: async () => null },
});

const digits = load<typeof import("../digits")>("../digits", {});

const rules = load<Rules>("../account-rules", { "./digits": digits, "./i18n": i18n });

const auth = load<Auth>("../auth", {
  "expo-constants": { __esModule: true, default: { executionEnvironment: "standalone" } },
  "expo-secure-store": {
    getItemAsync: async (key: string) => secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      secure.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      secure.delete(key);
    },
  },
  "react-native": reactNative,
  "../constants/env": { GOOGLE_IOS_CLIENT_ID: "", GOOGLE_WEB_CLIENT_ID: "web-client" },
  "./api": { getBackendUrl: async () => BASE },
  "./db-tx": {
    getAccountIdSync: () => (accountCacheReadHook ? accountCacheReadHook() : accountCache),
    getActiveVaultId: async () => null,
    getAppMetaInTx: async (_db: unknown, key: string) => metaGet(key),
    getDb: async () => sqlite,
    refreshAccountIdCache: async () => accountCache,
    setAccountIdCache: (id: string | null) => {
      accountCache = id;
    },
    setAppMetaInTx: async (_db: unknown, key: string, value: string) => metaSet(key, value),
    setInstallIdCache: () => {},
    setLocalSelfUserIdCache: () => {},
  },
  "./db": {
    // What the real wipe does: every table goes, then an empty schema.
    resetAllLocalData: async () => {
      trace.push("resetAllLocalData");
      fixture.exec(`DROP TABLE IF EXISTS app_meta; DROP TABLE IF EXISTS users;
        DROP TABLE IF EXISTS vaults; DROP TABLE IF EXISTS vault_members_mirror;
        DROP TABLE IF EXISTS event_log;`);
    },
    initDb: async () => {
      trace.push("initDb");
      fixture.exec(LEDGER);
    },
  },
  "./effective-account": { resolveAccountIdCandidates: async (id: string) => [id] },
  "./event-log": { appendAccountBound: async () => {} },
  "./phone": { normalizePhone: () => null },
  "./install-id": installId,
  // Loaded lazily by lib/auth: the restore placeholder name check.
  "./i18n": i18n,
  // Loaded lazily by lib/auth: fitting the phone's name for an automatic send.
  "./account-rules": rules,
  "./mesh": { registerDeviceKey: async () => {} },
  "./mesh/device-key": { clearDeviceKey: () => {} },
  "./tabs/sync": { reconcileTabsFromServer: async () => {} },
  "@react-native-google-signin/google-signin": {
    GoogleSignin: {
      hasPlayServices: async () => true,
      signOut: async () => {
        googleSignOuts++;
      },
      signIn: async () => {
        googleSignIns++;
        return googleResult;
      },
    },
    isErrorWithCode: (err: unknown) => typeof err === "object" && err !== null && "code" in err,
    statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED" },
  },
  "expo-apple-authentication": {
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    signInAsync: async () => ({ identityToken: appleIdentityToken, fullName: null, user: "apple" }),
  },
});

// The screens' copy of the rules, worded by KEY, so a case can name what is shown.
const keyT = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;
const keyRules = load<Rules>("../account-rules", { "./digits": digits, "./i18n": { t: keyT } });

// --- cases -----------------------------------------------------------------------

const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => cases.push([name, run]);

function refusal(err: unknown, reason: string, status: number) {
  assert.ok(err instanceof auth.EmailAuthError, `expected EmailAuthError ${reason}, got ${err}`);
  assert.equal(err.reason, reason);
  assert.equal(err.status, status);
  assert.equal(err.message, reason, "the message is the reason only");
  assert.ok(err instanceof auth.SignInFailedError, "still a coded server answer");
  return err;
}

test("start: the request, the answer, and the pending code step", async () => {
  freshPhone();
  script = [reply(200, { status: "sent", resend_after_s: 75 })];
  const before = Date.now();
  const sent = await auth.emailSignUpStart("  ahmad@example.com ", "fa");
  assert.deepEqual(sent, { resendAfterS: 75 });
  assert.deepEqual(calls[0], {
    url: `${BASE}/v1/auth/email/signup/start`,
    method: "POST",
    body: { email: "ahmad@example.com", lang: "fa" },
    auth: null,
  });
  const stored = JSON.parse(metaGet(PENDING_KEY) ?? "null");
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["email", "first_sent_at", "purpose", "sends", "sent_at"],
    "never a password or a code",
  );
  assert.deepEqual(stored.sends, [stored.sent_at]);
  assert.equal(stored.purpose, "signup");
  assert.equal(stored.email, "ahmad@example.com");
  assert.ok(stored.sent_at >= before && stored.sent_at <= Date.now());
  const pending = await auth.readEmailFlowPending();
  assert.deepEqual(pending, {
    purpose: "signup",
    email: "ahmad@example.com",
    sentAt: stored.sent_at,
    accountId: null,
  });

  script = [reply(200, { status: "sent" })];
  assert.deepEqual(await auth.emailResetStart("ahmad@example.com", "en"), { resendAfterS: 60 });
  assert.equal(calls[1].url, `${BASE}/v1/auth/email/reset/start`);
  assert.equal((await auth.readEmailFlowPending())?.purpose, "reset");
});

test("start: refusals are typed, word nothing the user typed, and store nothing", async () => {
  freshPhone();
  script = [reply(400, { error: "bad", error_code: "invalid_email", reason: "disposable" })];
  const bad = refusal(
    await rejection(auth.emailSignUpStart("x@tempmail.test", "en")),
    "invalid_email",
    400,
  );
  assert.equal(bad.extra.reason, "disposable");
  assert.ok(!bad.message.includes("tempmail") && !bad.code.includes("tempmail"));
  assert.equal(metaGet(PENDING_KEY), null, "a refused start leaves no code step");

  script = [reply(503, { error: "mail off", error_code: "email_unavailable" })];
  refusal(await rejection(auth.emailResetStart("a@example.com", "en")), "email_unavailable", 503);
  // A proxy page without JSON stays a plain coded server failure.
  script = [() => new Response("<html>bad gateway</html>", { status: 502 })];
  const plain = await rejection(auth.emailSignUpStart("a@example.com", "en"));
  assert.ok(plain instanceof auth.SignInFailedError && !(plain instanceof auth.EmailAuthError));
  assert.equal(plain.code, "server 502");
  assert.equal(metaGet(PENDING_KEY), null);
});

test("429: only a RETRIED start refused by the minute window counts as sent", async () => {
  const minute = reply(429, {
    error: "slow down",
    error_code: "too_many_requests",
    retry_after_s: 40,
    limit: "minute",
  });
  // Sent once: the minute window is a real refusal (someone asked a moment ago).
  freshPhone();
  script = [minute];
  const once = refusal(
    await rejection(auth.emailSignUpStart("a@example.com", "en")),
    "too_many_requests",
    429,
  );
  assert.equal(once.extra.limit, "minute");
  assert.equal(once.extra.retryAfterS, 40);
  assert.equal(metaGet(PENDING_KEY), null);
  // Sent twice: the lost first attempt is what used the minute, so its code is on the way.
  freshPhone();
  script = [lost, minute];
  assert.deepEqual(await auth.emailSignUpStart("a@example.com", "en"), { resendAfterS: 40 });
  assert.equal(calls.length, 2);
  assert.equal((await auth.readEmailFlowPending())?.purpose, "signup");
  // The hour and day windows are refusals however many times it was sent.
  for (const limit of ["hour", "day"]) {
    freshPhone();
    script = [
      lost,
      reply(429, { error: "x", error_code: "too_many_requests", retry_after_s: 1800, limit }),
    ];
    const err = refusal(
      await rejection(auth.emailResetStart("a@example.com", "en")),
      "too_many_requests",
      429,
    );
    assert.equal(err.extra.limit, limit);
    assert.equal(err.extra.retryAfterS, 1800);
    assert.equal(metaGet(PENDING_KEY), null, `${limit}: nothing pending`);
  }
});

test("429 without error_code is the per-IP limiter: Retry-After in seconds", async () => {
  freshPhone();
  script = [reply(429, { error: "rate limit exceeded; retry after 30s" }, { "Retry-After": "30" })];
  const ip = refusal(
    await rejection(auth.emailSignUpStart("a@example.com", "en")),
    "rate_limited",
    429,
  );
  assert.equal(ip.extra.retryAfterS, 30);
  // Retried, it is still a refusal: it says nothing about the address.
  freshPhone();
  script = [lost, reply(429, { error: "slow" }, { "Retry-After": "12" })];
  const retried = refusal(
    await rejection(auth.emailSignUpStart("a@example.com", "en")),
    "rate_limited",
    429,
  );
  assert.equal(retried.extra.retryAfterS, 12);
  assert.equal(metaGet(PENDING_KEY), null);
  // A Unix timestamp where seconds belong is ignored, as is an HTTP date.
  for (const header of ["1760000000", "86401", "Sat, 10 Oct 2026 10:00:00 GMT"]) {
    freshPhone();
    script = [reply(429, { error: "slow" }, { "Retry-After": header })];
    const err = refusal(
      await rejection(auth.emailSignUpStart("a@example.com", "en")),
      "rate_limited",
      429,
    );
    assert.equal(err.extra.retryAfterS, undefined, `Retry-After ${header} is not a wait`);
  }
  freshPhone();
  script = [reply(429, { error: "slow" }, { "Retry-After": "86400" })];
  const day = await rejection(auth.emailSignUpStart("a@example.com", "en"));
  assert.equal((day as InstanceType<Auth["EmailAuthError"]>).extra.retryAfterS, 86_400);
  // The body's own wait wins over the header.
  freshPhone();
  script = [
    reply(429, { error_code: "too_many_attempts", retry_after_s: 300 }, { "Retry-After": "9" }),
  ];
  const body = refusal(
    await rejection(auth.emailSignIn("a@example.com", "pw")),
    "too_many_attempts",
    429,
  );
  assert.equal(body.extra.retryAfterS, 300);
});

test("sign-in: request, session installed like any provider, pending step cleared", async () => {
  const install = freshPhone();
  metaSet(
    PENDING_KEY,
    JSON.stringify({ purpose: "reset", email: "a@example.com", sent_at: Date.now() }),
  );
  metaSet("account_google_sub", "google-sub-of-an-earlier-session");
  script = [reply(200, session("acct-email", "a@example.com"))];
  const user = await auth.emailSignIn("  Ahmad.K ", " secret pass ");
  assert.equal(user.email, "a@example.com");
  assert.deepEqual(calls[0].body, {
    install_id: install,
    identifier: "Ahmad.K",
    password: " secret pass ",
  });
  assert.equal(calls[0].url, `${BASE}/v1/auth/email/signin`);
  assert.equal(secure.get(SESSION_KEY), "jwt.acct-email");
  assert.equal(JSON.parse(secure.get(USER_KEY) ?? "{}").has_password, true);
  assert.equal(metaGet("account_id"), "acct-email");
  assert.equal(metaGet("account_display_email"), "a@example.com");
  assert.equal(metaGet("account_google_sub"), "", "an email session has no provider subject");
  assert.ok(Number(metaGet("account_last_seen_at")) > 0);
  assert.equal(metaGet(PENDING_KEY), "", "a signed-in flow is not reopened");
  assert.equal(accountCache, "acct-email");
});

test("sign-in, sign-up and reset refusals store no session", async () => {
  freshPhone();
  script = [reply(401, { error: "no", error_code: "invalid_credentials" })];
  const wrong = refusal(
    await rejection(auth.emailSignIn("ahmad", "hunter22")),
    "invalid_credentials",
    401,
  );
  assert.ok(!`${wrong.message} ${wrong.code}`.includes("hunter22"));
  assert.equal(secure.has(SESSION_KEY), false);

  script = [reply(400, { error: "weak", error_code: "weak_password", reason: "common" })];
  const weak = await rejection(
    auth.emailSignUpVerify({
      email: "a@example.com",
      code: "123456",
      password: "password1",
      lang: "en",
    }),
  );
  assert.equal(refusal(weak, "weak_password", 400).extra.reason, "common");
  assert.deepEqual(calls[1].body, {
    install_id: metaGet("install_id"),
    email: "a@example.com",
    code: "123456",
    password: "password1",
    lang: "en",
  });

  script = [reply(400, { error: "fmt", error_code: "invalid_code_format" })];
  refusal(
    await rejection(
      auth.emailResetVerify({ email: "a@example.com", code: "12", newPassword: "x", lang: "fa" }),
    ),
    "invalid_code_format",
    400,
  );
  assert.deepEqual(calls[2].body, {
    install_id: metaGet("install_id"),
    email: "a@example.com",
    code: "12",
    new_password: "x",
    lang: "fa",
  });
  assert.equal(calls[2].url, `${BASE}/v1/auth/email/reset/verify`);
  script = [reply(403, { error: "off", error_code: "account_disabled" })];
  refusal(await rejection(auth.emailSignIn("ahmad", "pw")), "account_disabled", 403);
  assert.equal(secure.has(SESSION_KEY), false);
});

test("a retired install is a retired install for email too", async () => {
  freshPhone();
  script = [reply(410, { error: "This installation belongs to a deleted account." })];
  const err = await rejection(auth.emailSignIn("a@example.com", "pw"));
  assert.ok(err instanceof auth.InstallRetiredError);
  assert.equal(metaGet("install_retired"), "1");
  script = [reply(200, session("acct", "a@example.com"))];
  await auth.emailSignIn("a@example.com", "pw");
  assert.equal(metaGet("install_retired"), null, "a later session clears it");
});

test("a nameless email account is given the phone's own name, once", async () => {
  // Signed in on a phone that already has its shopkeeper: the name goes at once.
  boundPhone("acct-email");
  script = [
    reply(200, session("acct-email", "a@example.com", { name: "" })),
    (call) => {
      assert.equal(call.method, "PUT");
      assert.equal(call.url, `${BASE}/v1/account/name`);
      assert.equal(call.auth, "Bearer jwt.acct-email");
      assert.deepEqual(call.body, { name: "Matee Saafi" });
      return reply(200, { name: "Matee Saafi" })();
    },
  ];
  await auth.emailSignIn("a@example.com", "pw");
  await until(() => calls.length === 2 && metaGet("account_name_pending") === "", "name sent");
  assert.equal(metaGet("account_name_pending"), "", "and is no longer owed");

  // A fresh install has no name yet: it is owed until onboarding gives one.
  freshPhone();
  script = [reply(200, session("acct-new", "n@example.com", { name: "" }))];
  await auth.emailSignIn("n@example.com", "pw");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(metaGet("account_name_pending"), "1");
  // Check-in's retry finds nothing to send yet.
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, 1);
  // The restore placeholder is never an account's name.
  fixture
    .prepare("INSERT INTO users (id, display_name, is_local_self) VALUES ('s', 'You', 1)")
    .run();
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, 1);
  // The onboarding name arrives (onboarding/profile).
  script = [reply(200, { name: "Ahmad Karimi" })];
  assert.equal(await auth.syncAccountName(" Ahmad Karimi "), true);
  assert.deepEqual(calls[1].body, { name: "Ahmad Karimi" });
  assert.equal(metaGet("account_name_pending"), "");
  // Settled: nothing more without an explicit edit.
  assert.equal(await auth.syncAccountName("Someone Else"), false);
  assert.equal(calls.length, 2);
  // An explicit edit in Account settings is always sent.
  script = [reply(200, { name: "Ahmad K." })];
  assert.equal(await auth.syncAccountName("Ahmad K.", { force: true }), true);
  assert.equal(calls.length, 3);
});

test("account name: refusals the server will repeat settle it; failures leave it owed", async () => {
  freshPhone();
  signedIn();
  metaSet("account_name_pending", "1");
  script = [lost];
  assert.equal(await auth.syncAccountName("Ahmad"), false);
  assert.equal(metaGet("account_name_pending"), "1", "offline: still owed, check-in retries");
  script = [reply(409, { error: "provider", error_code: "provider_name" })];
  assert.equal(await auth.syncAccountName("Ahmad"), false);
  assert.equal(metaGet("account_name_pending"), "", "a provider names this account");
  metaSet("account_name_pending", "1");
  script = [reply(400, { error: "bad", error_code: "invalid_name" })];
  assert.equal(await auth.syncAccountName("A"), false);
  assert.equal(
    metaGet("account_name_pending"),
    "invalid",
    "not swallowed: Account asks for a better name",
  );
  // A Google or Apple sign-in never owes a name.
  boundPhone("acct-g");
  metaSet("account_name_pending", "1");
  reactNative.Platform.OS = "android";
  script = [reply(200, { ...session("acct-g", "g@gmail.com", { sub: "g-sub", name: "" }) })];
  await auth.signInWithGoogle();
  assert.equal(metaGet("account_name_pending"), "");
  assert.equal(calls.length, 1);
});

type PromptArgs = { cachedEmail: string | null; newEmail: string | null };
function prompter(answer: "keep" | "wipe" | "cancel") {
  const asked: PromptArgs[] = [];
  const prompt = async (args: PromptArgs) => {
    asked.push(args);
    return answer;
  };
  return { asked, prompt };
}

// The server's question (§6, step 4), asked before it writes anything.
const differentAccount = reply(409, {
  error: "different account",
  error_code: "different_account",
  email: "new@example.com",
});

test("different account (email): keep resends with allow_switch; the ledger stays", async () => {
  const install = boundPhone("acct-old");
  const { asked, prompt } = prompter("keep");
  script = [differentAccount, reply(200, session("acct-new", "new@example.com"))];
  await auth.emailSignIn("new@example.com", "pw", { onDifferentAccount: prompt });
  assert.deepEqual(asked, [{ cachedEmail: "old@example.com", newEmail: "new@example.com" }]);
  assert.deepEqual(calls[0].body, {
    install_id: install,
    identifier: "new@example.com",
    password: "pw",
    current_account_id: "acct-old",
  });
  assert.deepEqual({ ...calls[1].body }, { ...calls[0].body, allow_switch: true });
  assert.equal(metaGet("account_id"), "acct-new");
  assert.equal(trace.includes("resetAllLocalData"), false);
  assert.ok(fixture.prepare("SELECT 1 FROM users WHERE id = 'self'").get(), "the ledger survives");
});

test("different account (email): wipe resends under a fresh install id, unprotected", async () => {
  const install = boundPhone("acct-old");
  const { prompt } = prompter("wipe");
  script = [differentAccount, reply(200, session("acct-new", "new@example.com"))];
  await auth.emailSignUpVerify(
    { email: "new@example.com", code: "123456", password: "Kabul-tea-77", lang: "en" },
    { onDifferentAccount: prompt },
  );
  const fresh = metaGet("install_id");
  assert.ok(fresh && fresh !== install, "a fresh install id");
  assert.equal(calls[0].body?.current_account_id, "acct-old");
  assert.equal(calls[1].body?.install_id, fresh);
  assert.equal("current_account_id" in (calls[1].body ?? {}), false);
  assert.equal("allow_switch" in (calls[1].body ?? {}), false);
  assert.equal(calls[1].body?.code, "123456", "the code is still unused");
  assert.deepEqual(trace, ["resetAllLocalData", "initDb"]);
  assert.equal(fixture.prepare("SELECT 1 FROM users").get(), undefined, "the old ledger is gone");
  assert.equal(metaGet("account_id"), "acct-new");
  assert.equal(secure.get(SESSION_KEY), "jwt.acct-new");
});

test("different account (email): cancel stops and writes nothing", async () => {
  boundPhone("acct-old");
  const { prompt } = prompter("cancel");
  script = [differentAccount];
  const err = await rejection(
    auth.emailSignIn("new@example.com", "pw", { onDifferentAccount: prompt }),
  );
  assert.ok(err instanceof auth.SignInCancelledByUserError);
  assert.equal(auth.isCancellation(err), true, "the screens swallow it");
  assert.equal(calls.length, 1);
  assert.equal(secure.has(SESSION_KEY), false);
  assert.equal(metaGet("account_id"), "acct-old");
});

test("different account: nothing to protect, nothing asked", async () => {
  const setups: Array<[string, () => void]> = [
    ["idle 31 days", () => void boundPhone("acct-old", 31 * DAY_MS)],
    [
      "no ledger",
      () => {
        boundPhone("acct-old");
        fixture.exec("DELETE FROM users");
      },
    ],
    ["never signed in", () => void freshPhone()],
  ];
  for (const [name, setup] of setups) {
    setup();
    const { asked, prompt } = prompter("cancel");
    script = [reply(200, session("acct-new", "new@example.com"))];
    await auth.emailSignIn("new@example.com", "pw", { onDifferentAccount: prompt });
    assert.equal("current_account_id" in (calls[0].body ?? {}), false, `${name}: unprotected`);
    assert.equal(asked.length, 0, name);
  }
  boundPhone("acct-old");
  script = [reply(200, session("acct-new", "new@example.com"))];
  await auth.emailSignIn("new@example.com", "pw");
  assert.equal("current_account_id" in (calls[0].body ?? {}), false, "no prompt, nobody to ask");
  // A kaata counts as local data as much as a person does.
  boundPhone("acct-old");
  fixture.exec("DELETE FROM users; INSERT INTO vaults (id) VALUES ('v1')");
  script = [reply(200, session("acct-old", "old@example.com"))];
  await auth.emailSignIn("old@example.com", "pw", { onDifferentAccount: prompter("keep").prompt });
  assert.equal(calls[0].body?.current_account_id, "acct-old");
});

test("different account (Google): the same three answers, the ID token reused", async () => {
  reactNative.Platform.OS = "android";
  let install = boundPhone("acct-old");
  script = [differentAccount, reply(200, session("acct-g", "g@gmail.com", { sub: "g-sub" }))];
  await auth.signInWithGoogle(prompter("keep").prompt);
  assert.equal(googleSignIns, 1, "the chooser opened once");
  assert.deepEqual(
    calls.map((c) => c.url),
    [`${BASE}/v1/auth/google`, `${BASE}/v1/auth/google`],
  );
  assert.equal(calls[0].body?.id_token, "google.id.token");
  assert.equal(calls[0].body?.current_account_id, "acct-old");
  assert.deepEqual({ ...calls[1].body }, { ...calls[0].body, allow_switch: true });
  assert.equal(calls[1].body?.install_id, install);
  assert.equal(metaGet("account_google_sub"), "g-sub");

  install = boundPhone("acct-old");
  script = [differentAccount, reply(200, session("acct-g", "g@gmail.com", { sub: "g-sub" }))];
  await auth.signInWithGoogle(prompter("wipe").prompt);
  const fresh = metaGet("install_id");
  assert.ok(fresh && fresh !== install, "a fresh install id");
  assert.equal(calls[1].body?.id_token, "google.id.token", "the unused token is sent again");
  assert.equal(calls[1].body?.install_id, fresh);
  assert.equal("current_account_id" in (calls[1].body ?? {}), false);
  assert.equal("allow_switch" in (calls[1].body ?? {}), false);
  assert.ok(trace.includes("resetAllLocalData"));

  boundPhone("acct-old");
  script = [differentAccount];
  const err = await rejection(auth.signInWithGoogle(prompter("cancel").prompt));
  assert.ok(err instanceof auth.SignInCancelledByUserError);
  assert.equal(calls.length, 1);
  // One sign-out clears Google's cache before the chooser; the cancel adds the
  // second, so the next tap opens the chooser instead of reusing this account.
  assert.equal(googleSignOuts, 2);
  assert.equal(secure.has(SESSION_KEY), false);
});

test("different account (Apple): keep resends the same identity token", async () => {
  reactNative.Platform.OS = "ios";
  try {
    boundPhone("acct-old");
    script = [differentAccount, reply(200, session("acct-a", "a@icloud.com", { sub: "apple" }))];
    await auth.signInWithApple(prompter("keep").prompt);
    assert.equal(calls[0].body?.identity_token, "apple.id.token");
    assert.equal(calls[0].body?.current_account_id, "acct-old");
    assert.deepEqual({ ...calls[1].body }, { ...calls[0].body, allow_switch: true });
  } finally {
    reactNative.Platform.OS = "android";
  }
});

test("backing out of Google's chooser is a silent cancel, asked once", async () => {
  freshPhone();
  googleResult = { type: "cancelled", data: null };
  const err = await rejection(auth.signInWithGoogle());
  assert.ok(err instanceof auth.SignInCancelledByUserError);
  assert.equal(auth.isCancellation(err), true, "the screens swallow it");
  assert.equal(googleSignIns, 1, "the chooser is not reopened");
  assert.equal(calls.length, 0);
});

const SIGNUP_VERIFY = `${BASE}/v1/auth/email/signup/verify`;
const SIGNIN = `${BASE}/v1/auth/email/signin`;

test("retry fallback: a lost verify's invalid_code or account_exists → password sign-in", async () => {
  for (const [status, code] of [
    [401, "invalid_code"],
    [409, "account_exists"],
  ] as const) {
    const install = freshPhone();
    script = [
      lost,
      reply(status, { error: "x", error_code: code }),
      reply(200, session("acct-new", "a@example.com")),
    ];
    const user = await auth.emailSignUpVerify({
      email: " a@example.com ",
      code: "123456",
      password: "Kabul-tea-77",
      lang: "en",
    });
    assert.equal(user.email, "a@example.com", `${code}: our own earlier success`);
    assert.deepEqual(
      calls.map((c) => c.url),
      [SIGNUP_VERIFY, SIGNUP_VERIFY, SIGNIN],
    );
    assert.deepEqual(calls[2].body, {
      install_id: install,
      identifier: "a@example.com",
      password: "Kabul-tea-77",
    });
    assert.equal(secure.get(SESSION_KEY), "jwt.acct-new");
  }
});

test("retry fallback: only after a possible landing; its own refusal keeps the original", async () => {
  // Sent once and refused: a real refusal, no sign-in attempted.
  freshPhone();
  script = [reply(401, { error: "x", error_code: "invalid_code" })];
  const args = { email: "a@example.com", code: "123456", password: "Kabul-tea-77", lang: "en" };
  refusal(await rejection(auth.emailSignUpVerify(args)), "invalid_code", 401);
  assert.equal(calls.length, 1);
  // The screen's previous attempt timed out: the same fallback, on a single send.
  freshPhone();
  script = [
    reply(401, { error: "x", error_code: "invalid_code" }),
    reply(200, session("acct", "a@example.com")),
  ];
  await auth.emailResetVerify(
    { email: "a@example.com", code: "123456", newPassword: "New-pass-99", lang: "en" },
    { afterTimeout: true },
  );
  assert.equal(calls[0].url, `${BASE}/v1/auth/email/reset/verify`);
  assert.deepEqual(calls[1].body?.password, "New-pass-99", "the NEW password signs in");
  // The fallback refused too: the user reads the original answer.
  freshPhone();
  script = [
    lost,
    reply(401, { error: "x", error_code: "invalid_code" }),
    reply(401, { error: "x", error_code: "invalid_credentials" }),
  ];
  refusal(await rejection(auth.emailSignUpVerify(args)), "invalid_code", 401);
  assert.equal(secure.has(SESSION_KEY), false);
  // Both attempts lost: a network failure, coded.
  freshPhone();
  script = [lost, lost];
  const net = await rejection(auth.emailSignUpVerify(args));
  assert.ok(net instanceof auth.SignInFailedError && net.stage === "network");
});

test("retry fallback carries the different-account answer: asked once", async () => {
  boundPhone("acct-old");
  const { asked, prompt } = prompter("keep");
  script = [
    differentAccount,
    lost,
    reply(401, { error: "x", error_code: "invalid_code" }),
    reply(200, session("acct-new", "new@example.com")),
  ];
  await auth.emailSignUpVerify(
    { email: "new@example.com", code: "123456", password: "Kabul-tea-77", lang: "en" },
    { onDifferentAccount: prompt },
  );
  assert.equal(asked.length, 1, "never asked twice");
  assert.deepEqual(
    calls.map((c) => c.url),
    [SIGNUP_VERIFY, SIGNUP_VERIFY, SIGNUP_VERIFY, SIGNIN],
  );
  assert.equal(calls[3].body?.allow_switch, true, "the fallback keeps the user's keep");
  assert.equal(metaGet("account_id"), "acct-new");
});

test("pending code step: 15 minutes, then forgotten; never a secret", async () => {
  freshPhone();
  const realNow = Date.now;
  let clock = 1_790_000_000_000;
  Date.now = () => clock;
  try {
    script = [reply(200, { status: "sent", resend_after_s: 60 })];
    await auth.emailSignUpStart("a@example.com", "en");
    clock += 14 * 60_000;
    assert.equal((await auth.readEmailFlowPending())?.email, "a@example.com", "14 min: reopened");
    clock += 61_000;
    assert.equal(await auth.readEmailFlowPending(), null, "15 min: the code is dead");
    assert.equal(metaGet(PENDING_KEY), "", "and forgotten");
    // A clock set back by more than the code's life ends it too.
    metaSet(
      PENDING_KEY,
      JSON.stringify({ purpose: "signup", email: "a@example.com", sent_at: clock + 20 * 60_000 }),
    );
    assert.equal(await auth.readEmailFlowPending(), null);
    for (const raw of [
      "{",
      "null",
      JSON.stringify({ purpose: "login", email: "a@example.com", sent_at: clock }),
      JSON.stringify({ purpose: "signup", sent_at: clock }),
      JSON.stringify({ purpose: "signup", email: "a@example.com", sent_at: String(clock) }),
    ]) {
      metaSet(PENDING_KEY, raw);
      assert.equal(await auth.readEmailFlowPending(), null, `unreadable: ${raw}`);
      assert.equal(metaGet(PENDING_KEY), "", "forgotten");
    }
    metaSet(PENDING_KEY, JSON.stringify({ purpose: "reset", email: "a@x.co", sent_at: clock }));
    await auth.clearEmailFlowPending();
    assert.equal(await auth.readEmailFlowPending(), null, "Back / Change email forget it");
  } finally {
    Date.now = realNow;
  }
});

test("account endpoints: session-bound, sent once, typed refusals", async () => {
  freshPhone();
  refusal(await rejection(auth.fetchAccountMe()), "session_expired", 401);
  assert.equal(calls.length, 0, "no session, no request");
  signedIn("jwt.me");
  script = [
    reply(200, {
      email: "x@privaterelay.appleid.com",
      login_email: null,
      username: null,
      has_password: false,
      providers: ["apple"],
      name: "Ahmad",
    }),
  ];
  assert.deepEqual(await auth.fetchAccountMe(), {
    email: "x@privaterelay.appleid.com",
    loginEmail: null,
    username: null,
    hasPassword: false,
    providers: ["apple"],
    name: "Ahmad",
    setupEmail: null,
  });
  assert.deepEqual(calls[0], {
    url: `${BASE}/v1/account/me`,
    method: "GET",
    body: undefined,
    auth: "Bearer jwt.me",
  });
  // 401 always means the session ended, whatever the body names.
  script = [reply(401, { error: "x", error_code: "wrong_password" })];
  refusal(
    await rejection(auth.changePassword("old", "Kabul-tea-77", "en")),
    "session_expired",
    401,
  );
  // A wrong current password is 403, never 401.
  script = [reply(403, { error: "wrong", error_code: "wrong_password" })];
  refusal(await rejection(auth.changePassword("old", "Kabul-tea-77", "en")), "wrong_password", 403);
  assert.equal(calls.at(-1)?.method, "PUT");
  assert.equal(calls.at(-1)?.url, `${BASE}/v1/account/password`);
  assert.deepEqual(calls.at(-1)?.body, {
    current_password: "old",
    new_password: "Kabul-tea-77",
    lang: "en",
  });
  // Sent ONCE even when lost: a second send would read as a wrong password.
  const before = calls.length;
  script = [lost];
  const lostErr = await rejection(auth.changePassword("old", "Kabul-tea-77", "en"));
  assert.ok(lostErr instanceof auth.SignInFailedError && lostErr.stage === "network");
  assert.equal(calls.length, before + 1);
  // Setup: to an address of the user's choosing, or the account's own.
  script = [reply(200, { status: "sent", resend_after_s: 60 })];
  await auth.passwordSetupStart(" me@example.com ", "fa");
  assert.equal(calls.at(-1)?.url, `${BASE}/v1/account/password/setup/start`);
  assert.deepEqual(calls.at(-1)?.body, { email: "me@example.com", lang: "fa" });
  assert.equal((await auth.readEmailFlowPending())?.purpose, "setup");
  script = [reply(400, { error: "relay", error_code: "email_required" })];
  refusal(await rejection(auth.passwordSetupStart(null, "en")), "email_required", 400);
  assert.deepEqual(calls.at(-1)?.body, { lang: "en" });
  for (const code of ["password_exists", "email_in_use"]) {
    script = [reply(409, { error: "x", error_code: code })];
    refusal(await rejection(auth.passwordSetupStart("me@example.com", "en")), code, 409);
  }
  script = [reply(200, { has_password: true, login_email: "me@example.com" })];
  assert.deepEqual(await auth.passwordSetupVerify("123456", "Kabul-tea-77", "fa"), {
    loginEmail: "me@example.com",
  });
  assert.deepEqual(calls.at(-1)?.body, {
    code: "123456",
    new_password: "Kabul-tea-77",
    lang: "fa",
  });
  assert.equal(secure.get(SESSION_KEY), "jwt.me", "no new session");
  assert.equal(await auth.readEmailFlowPending(), null, "the setup step is done");
  // Username: set (the server lowercases), refused, removed.
  script = [reply(200, { username: "ahmad_k" })];
  assert.equal(await auth.setUsername("  Ahmad_K "), "ahmad_k");
  assert.equal(calls.at(-1)?.url, `${BASE}/v1/account/username`);
  assert.deepEqual(calls.at(-1)?.body, { username: "Ahmad_K" });
  script = [reply(409, { error: "taken", error_code: "username_taken" })];
  refusal(await rejection(auth.setUsername("ahmad")), "username_taken", 409);
  script = [reply(400, { error: "bad", error_code: "invalid_username", reason: "reserved" })];
  const reserved = refusal(await rejection(auth.setUsername("kaata_x")), "invalid_username", 400);
  assert.equal(reserved.extra.reason, "reserved");
  script = [reply(200, { username: null })];
  assert.equal(await auth.setUsername(""), null, "removed");
  assert.deepEqual(calls.at(-1)?.body, { username: "" });
  script = [reply(200, { name: "Ahmad" })];
  assert.equal(await auth.setAccountName(" Ahmad "), "Ahmad");
  assert.deepEqual(calls.at(-1)?.body, { name: "Ahmad" });
});

test("rules: codes, addresses, passwords and usernames mirror the server", async () => {
  assert.equal(rules.normalizeCodeInput("۱۲۳ ٤٥٦"), "123456", "Persian and Arabic-Indic digits");
  assert.equal(rules.normalizeCodeInput("12-34 56 78"), "123456");
  assert.equal(rules.normalizeCodeInput("abc"), "");
  assert.equal(rules.emailProblem("  "), "empty");
  for (const bad of [
    "ahmad",
    "ahmad@",
    "@example.com",
    "a b@example.com",
    "a@b",
    "a@[1.2.3.4]",
    "a@@b.com",
    ".a@b.com",
    "a..b@c.com",
    '"a"@b.com',
    "Ahmad <a@b.com>",
    "احمد@example.com",
  ]) {
    assert.equal(rules.emailProblem(bad), "format", bad);
  }
  assert.equal(rules.emailProblem("x@privaterelay.appleid.com"), "relay");
  for (const ok of ["ahmad@example.com", " A.Karimi+shop@Gmail.com ", "user۱@mail.kaata.af"]) {
    assert.equal(rules.emailProblem(ok), null, ok);
  }
  assert.equal(rules.normalizeEmailInput(" user۱@example.com "), "user1@example.com");
  assert.equal(rules.isGmailAddress(" A@GMAIL.COM"), true);
  assert.equal(rules.isGmailAddress("a@googlemail.com"), true);
  assert.equal(rules.isGmailAddress("a@gmail.co"), false);
  // Passwords: the structural rules only; common and personal are the server's.
  assert.equal(rules.newPasswordProblem("short1"), "too_short");
  assert.equal(rules.newPasswordProblem(`Ka-${"x1".repeat(63)}`), "too_long");
  assert.equal(rules.newPasswordProblem(" Kabul-tea-77"), "whitespace");
  assert.equal(rules.newPasswordProblem("90731526481"), "pattern", "digits only, under 12");
  assert.equal(rules.newPasswordProblem("907315264810"), null, "12 digits are allowed");
  assert.equal(rules.newPasswordProblem("abcdef-Kabul"), "pattern", "a rising run of six");
  assert.equal(rules.newPasswordProblem("Kabul-fedcba"), "pattern", "a falling run");
  assert.equal(rules.newPasswordProblem("Kabul-zzzzzz"), "pattern", "a repeated run");
  assert.equal(rules.newPasswordProblem("abcde-Kabul1"), null, "a run of five is fine");
  assert.equal(rules.newPasswordProblem("Kabul-tea-77"), null);
  assert.equal(rules.newPasswordProblem("password1"), null, "common: the server's call");
  // Canonicalized like the server: the same visible password from any keyboard.
  assert.equal(rules.canonicalPassword("\u0643\u064a\u0649\u200c\u06f1"), "\u06a9\u06cc\u06cc1");
  assert.equal(rules.newPasswordProblem("abc\u200cdefg"), "too_short", "joiners count for nothing");
  assert.deepEqual(rules.passwordRules(""), { length: false, notOnlyDigits: false, noRuns: false });
  assert.deepEqual(rules.passwordRules("Kabul-tea-77"), {
    length: true,
    notOnlyDigits: true,
    noRuns: true,
  });
  // Usernames.
  assert.equal(rules.usernameProblem(" Ahmad_77 "), null);
  assert.equal(rules.normalizeUsernameInput(" Ahmad_۷۷ "), "ahmad_77");
  for (const bad of ["ab", "1ahmad", "ahmad..k", "ahmad.", "ahmad k", "a".repeat(31), "احمد"]) {
    assert.equal(rules.usernameProblem(bad), "format", bad);
  }
  for (const reserved of ["kaata_shop", "theadmin", "helpdesk", "rootbeer"]) {
    assert.equal(rules.usernameProblem(reserved), "reserved", reserved);
  }
  assert.equal(rules.countdownText(42), "0:42");
  assert.equal(rules.countdownText(75), "1:15");
  assert.equal(rules.countdownText(0), "0:00");
  assert.equal(rules.waitText(42), "42 seconds");
  assert.equal(rules.waitText(60), "1 minute");
  assert.equal(rules.waitText(61), "2 minutes");
  assert.equal(rules.waitText(3600), "1 hour");
  assert.equal(rules.waitText(5400), "2 hours");
});

// Every error_code of docs/kaata-accounts.md §6, with the details it can carry.
const ERROR_CODES: Array<[string, number, Record<string, unknown>?]> = [
  ["invalid_email", 400, { reason: "format" }],
  ["invalid_email", 400, { reason: "relay" }],
  ["invalid_email", 400, { reason: "disposable" }],
  ["email_required", 400],
  ["email_in_use", 409],
  ...["too_short", "too_long", "whitespace", "common", "personal", "pattern", "new_one"].map(
    (reason): [string, number, Record<string, unknown>] => ["weak_password", 400, { reason }],
  ),
  ["invalid_code_format", 400],
  ["invalid_code", 401],
  ["account_exists", 409],
  ["invalid_credentials", 401],
  ["wrong_password", 403],
  ["no_password", 409],
  ["password_exists", 409],
  ["invalid_username", 400, { reason: "format" }],
  ["invalid_username", 400, { reason: "reserved" }],
  ["username_taken", 409],
  ["invalid_name", 400],
  ["provider_name", 409],
  ["too_many_attempts", 429, { retryAfterS: 300 }],
  ["too_many_attempts", 429],
  ["too_many_requests", 429, { retryAfterS: 3600, limit: "hour" }],
  ["too_many_requests", 429],
  ["rate_limited", 429, { retryAfterS: 30 }],
  ["rate_limited", 429],
  ["email_unavailable", 503],
  ["busy", 503],
  ["account_disabled", 403],
  ["session_expired", 401],
  ["email_fixed", 409],
  ["provider_session_required", 403],
];

test("copy: every error code of §6 has its own words, in English and Dari", async () => {
  try {
    for (const [code, status, extra] of ERROR_CODES) {
      i18n.setLocale("en");
      const en = rules.accountRefusal(new auth.EmailAuthError(code, status, extra ?? {}));
      assert.ok(en && en.text && !/^auth\./.test(en.text), `${code}: English copy`);
      i18n.setLocale("fa");
      const fa = rules.accountRefusal(new auth.EmailAuthError(code, status, extra ?? {}));
      assert.ok(fa && fa.text !== en.text && /[\u0600-\u06ff]/.test(fa.text), `${code}: own Dari`);
    }
  } finally {
    i18n.setLocale("en");
  }
  const timed = rules.accountRefusal(
    new auth.EmailAuthError("too_many_attempts", 429, { retryAfterS: 300 }),
  );
  assert.match(timed?.text ?? "", /5 minutes/, "the wait is in the words");
  assert.equal(rules.accountRefusal(new auth.EmailAuthError("invalid_code", 401))?.field, "code");
  assert.equal(
    rules.accountRefusal(new auth.EmailAuthError("wrong_password", 403))?.field,
    "currentPassword",
  );
  assert.equal(rules.accountRefusal(new auth.SignInFailedError("timeout", "t")), null);
  assert.equal(rules.accountRefusal(new Error("x")), null);
  assert.equal(
    rules.accountFailureText(new auth.SignInFailedError("network", "x")),
    i18n.t("account.signin.network"),
  );
  assert.equal(
    rules.accountFailureText(new auth.SignInFailedError("server", "x", "500")),
    `${i18n.t("account.signin.error")} (server 500)`,
  );
});

test("copy: every new string in English and its own Dari; provider-neutral where it must be", async () => {
  const src = readFileSync(require.resolve("../i18n"), "utf8");
  assert.ok(!src.includes("auth.username."), "the review login's strings are gone");
  const pattern =
    /^\s+"((?:auth\.(?:email|password|error|wait)|account\.signin|accountPassword|accountUsername)\.[^"]+)":/gm;
  const keys = new Set([...src.matchAll(pattern)].map((m) => m[1]));
  for (const extra of [
    "onboardingMode.email.title",
    "menu.account.signIn.email",
    "menu.account.signIn.choose",
    "inviteAccept.signin.cta",
  ]) {
    keys.add(extra);
  }
  assert.ok(keys.size > 80, `found ${keys.size} keys`);
  for (const key of keys) {
    const en = i18n.tIn("en", key as never);
    const fa = i18n.tIn("fa", key as never);
    assert.ok(en && en !== key, `${key}: English`);
    assert.ok(fa && fa !== en, `${key}: its own Dari`);
  }
  for (const key of [
    "account.differentAccount.title",
    "account.differentAccount.body",
    "vaultPair.instructions.server",
    "vaultPair.fineprint.server",
    "vaultPairScan.error.signInRequired",
    "vaultPairScan.error.accountMismatch",
    "pairLink.signin.body",
    "pairLink.error.accountMismatch",
    "invite.gmailDotHint",
    "inviteAccept.signin.body",
    "inviteAccept.error.notVisible",
  ]) {
    for (const locale of ["en", "fa"] as const) {
      assert.doesNotMatch(i18n.tIn(locale, key as never), /Google|گوگل/, `${locale} ${key}`);
    }
  }
  // The contract's own words (docs/kaata-accounts.md §7).
  assert.equal(i18n.tIn("en", "onboardingMode.email.title"), "Continue with email");
  assert.equal(
    i18n.tIn("en", "auth.email.newPassword.helper"),
    "Make a new password for Kaata, not your Gmail password",
  );
  assert.equal(i18n.tIn("en", "auth.email.gmail"), "Continue with Google: no password needed");
  assert.equal(
    i18n.tIn("en", "auth.email.providerHint"),
    "Joined with Google or Apple? Use that button.",
  );
});

test("password change: this session stays, and its re-signed token is stored", async () => {
  freshPhone();
  signedIn("jwt.before");
  script = [reply(200, { status: "ok", session_jwt: "jwt.resigned" })];
  await auth.changePassword("Old-pass-11", "New-pass-22", "en");
  assert.equal(secure.get(SESSION_KEY), "jwt.resigned", "stored where every sign-in keeps it");
  // A reply without a token leaves the current one alone.
  script = [reply(200, { status: "ok" })];
  await auth.changePassword("New-pass-22", "New-pass-33", "en");
  assert.equal(secure.get(SESSION_KEY), "jwt.resigned");
  // Signed out while the change was on its way: the late reply brings nothing back.
  script = [
    async () => {
      await auth.clearLocalSession();
      return reply(200, { status: "ok", session_jwt: "jwt.late" })();
    },
  ];
  await auth.changePassword("New-pass-33", "New-pass-44", "en");
  assert.equal(secure.has(SESSION_KEY), false, "no session resurrected");
  // Another sign-in landed while the change was on its way: its session stays.
  signedIn("jwt.a");
  script = [
    async () => {
      script.unshift(reply(200, session("acct-b", "b@example.com")));
      await auth.emailSignIn("b@example.com", "pw-of-b");
      return reply(200, { status: "ok", session_jwt: "jwt.late-for-a" })();
    },
  ];
  await auth.changePassword("Pass-of-a-1", "Pass-of-a-2", "en");
  assert.equal(secure.get(SESSION_KEY), "jwt.acct-b", "the newer session is never replaced");
});

test("remove password: DELETE in the app's language; an email session is refused", async () => {
  freshPhone();
  signedIn("jwt.google");
  script = [reply(200, { has_password: false })];
  await auth.removePassword("fa");
  assert.deepEqual(calls[0], {
    url: `${BASE}/v1/account/password?lang=fa`,
    method: "DELETE",
    body: undefined,
    auth: "Bearer jwt.google",
  });
  script = [reply(403, { error: "x", error_code: "provider_session_required" })];
  const err = refusal(await rejection(auth.removePassword("en")), "provider_session_required", 403);
  const shown = rules.accountRefusal(err);
  assert.equal(shown?.field, "form");
  assert.equal(shown?.text, i18n.t("auth.error.providerSessionRequired"));
  assert.equal(secure.get(SESSION_KEY), "jwt.google", "a 403 never ends the session");
});

test("set a password: the fixed address, email_fixed, and a wrong code is 400", async () => {
  freshPhone();
  signedIn("jwt.g");
  script = [
    reply(200, {
      email: "a@gmail.com",
      login_email: null,
      username: null,
      has_password: false,
      providers: ["google"],
      name: "A",
      setup_email: "a@gmail.com",
    }),
  ];
  assert.equal((await auth.fetchAccountMe()).setupEmail, "a@gmail.com");
  script = [reply(409, { error: "x", error_code: "email_fixed" })];
  const fixed = refusal(
    await rejection(auth.passwordSetupStart("other@example.com", "en")),
    "email_fixed",
    409,
  );
  assert.equal(rules.accountRefusal(fixed)?.field, "email");
  // On a session route a wrong code is 400 invalid_code: under the code field,
  // never "you've been signed out".
  script = [reply(400, { error: "x", error_code: "invalid_code" })];
  const wrong = refusal(
    await rejection(auth.passwordSetupVerify("123456", "Kabul-tea-77", "en")),
    "invalid_code",
    400,
  );
  assert.equal(rules.accountRefusal(wrong)?.field, "code");
  assert.equal(secure.get(SESSION_KEY), "jwt.g", "the session stays");
});

test("429 rate_limited WITH an error_code: worded like the bare one, never 'code sent'", async () => {
  freshPhone();
  script = [reply(429, { error: "slow", error_code: "rate_limited", retry_after_s: 1200 })];
  const body = refusal(
    await rejection(auth.emailSignUpStart("a@example.com", "en")),
    "rate_limited",
    429,
  );
  assert.equal(body.extra.retryAfterS, 1200, "the body's wait");
  freshPhone();
  script = [reply(429, { error: "slow", error_code: "rate_limited" }, { "Retry-After": "90" })];
  const header = refusal(
    await rejection(auth.emailResetStart("a@example.com", "en")),
    "rate_limited",
    429,
  );
  assert.equal(header.extra.retryAfterS, 90, "else Retry-After");
  freshPhone();
  script = [lost, reply(429, { error: "slow", error_code: "rate_limited", retry_after_s: 60 })];
  refusal(await rejection(auth.emailSignUpStart("a@example.com", "en")), "rate_limited", 429);
  assert.equal(metaGet(PENDING_KEY), null, "a client budget is never 'the first one landed'");
  const text = rules.accountRefusal(header)?.text ?? "";
  assert.doesNotMatch(text, /network/i, "no blame on the network");
  assert.match(text, /2 minutes/);
});

test("a stale token or code is refused BEFORE 'start fresh' erases anything", async () => {
  reactNative.Platform.OS = "android";
  for (const choice of ["wipe", "keep"] as const) {
    boundPhone("acct-old");
    googleResult = {
      type: "success",
      data: { idToken: jwtWith({ sub: "g", exp: inSeconds(30) }) },
    };
    script = [differentAccount];
    const err = await rejection(auth.signInWithGoogle(prompter(choice).prompt));
    assert.ok(err instanceof auth.SignInFailedError && err.stage === "token_expired", choice);
    assert.equal(calls.length, 1, `${choice}: nothing resent`);
    assert.equal(trace.includes("resetAllLocalData"), false, `${choice}: no wipe`);
    assert.ok(fixture.prepare("SELECT 1 FROM users WHERE id = 'self'").get(), "ledger intact");
    assert.equal(metaGet("account_id"), "acct-old");
  }
  // A token with life left goes ahead.
  boundPhone("acct-old");
  googleResult = {
    type: "success",
    data: { idToken: jwtWith({ sub: "g", exp: inSeconds(3000) }) },
  };
  script = [differentAccount, reply(200, session("acct-g", "g@gmail.com", { sub: "g" }))];
  await auth.signInWithGoogle(prompter("wipe").prompt);
  assert.ok(trace.includes("resetAllLocalData"));
  // Apple's identity token the same.
  reactNative.Platform.OS = "ios";
  try {
    boundPhone("acct-old");
    appleIdentityToken = jwtWith({ sub: "apple", exp: inSeconds(-5) });
    script = [differentAccount];
    const apple = await rejection(auth.signInWithApple(prompter("wipe").prompt));
    assert.ok(apple instanceof auth.SignInFailedError && apple.stage === "token_expired");
    assert.equal(trace.includes("resetAllLocalData"), false);
  } finally {
    reactNative.Platform.OS = "android";
  }
  // An emailed code past 14 minutes: "start fresh" is refused before the wipe.
  const args = { email: "new@example.com", code: "123456", password: "Kabul-tea-77", lang: "en" };
  const oldCode = JSON.stringify({
    purpose: "signup",
    email: "new@example.com",
    sent_at: Date.now() - 14.5 * 60_000,
  });
  boundPhone("acct-old");
  metaSet(PENDING_KEY, oldCode);
  script = [differentAccount];
  const code = await rejection(
    auth.emailSignUpVerify(args, { onDifferentAccount: prompter("wipe").prompt }),
  );
  assert.ok(code instanceof auth.SignInFailedError && code.stage === "token_expired");
  assert.equal(trace.includes("resetAllLocalData"), false);
  assert.equal(calls.length, 1);
  // "Keep" erases nothing: the code goes to the server, which judges it.
  boundPhone("acct-old");
  metaSet(PENDING_KEY, oldCode);
  script = [differentAccount, reply(401, { error: "x", error_code: "invalid_code" })];
  refusal(
    await rejection(auth.emailSignUpVerify(args, { onDifferentAccount: prompter("keep").prompt })),
    "invalid_code",
    401,
  );
  assert.equal(calls.length, 2);
});

test("a pending code step ends with every sign-in and sign-out, and is one account's", async () => {
  boundPhone("acct-a");
  signedIn("jwt.a");
  script = [reply(200, { status: "sent", resend_after_s: 60 })];
  await auth.passwordSetupStart(null, "en");
  assert.equal(JSON.parse(metaGet(PENDING_KEY) ?? "{}").account_id, "acct-a", "its account");
  assert.equal((await auth.readSetupFlowPending())?.accountId, "acct-a");
  // A Google sign-in after a set-password start: nothing left to resume.
  reactNative.Platform.OS = "android";
  script = [reply(200, session("acct-a", "a@gmail.com", { sub: "g" }))];
  await auth.signInWithGoogle();
  assert.equal(await auth.readEmailFlowPending(), null, "a sign-in ends it");
  // Sign-out after a set-password start: nothing either.
  script = [reply(200, { status: "sent" })];
  await auth.passwordSetupStart(null, "en");
  assert.ok(await auth.readEmailFlowPending());
  script = [reply(200, {})];
  await auth.signOut();
  assert.equal(await auth.readEmailFlowPending(), null, "a sign-out ends it");
  // A setup step another account left behind is never offered here.
  metaSet("account_id", "acct-a");
  metaSet(
    PENDING_KEY,
    JSON.stringify({
      purpose: "setup",
      email: "x@y.co",
      sent_at: Date.now(),
      account_id: "acct-b",
    }),
  );
  assert.equal(await auth.readSetupFlowPending(), null);
  assert.equal(metaGet(PENDING_KEY), "", "and is forgotten");
  // Nor one an older build stored without its account.
  metaSet(PENDING_KEY, JSON.stringify({ purpose: "setup", email: "x@y.co", sent_at: Date.now() }));
  assert.equal(await auth.readSetupFlowPending(), null);
  // A sign-up step is the sign-in screen's, not Account settings'.
  metaSet(PENDING_KEY, JSON.stringify({ purpose: "signup", email: "x@y.co", sent_at: Date.now() }));
  assert.equal(await auth.readSetupFlowPending(), null);
  assert.equal((await auth.readEmailFlowPending())?.purpose, "signup", "left for its screen");
});

test("only the newest session token counts: stale refreshes and stale 401s change nothing", async () => {
  const claims = { account_id: "acct", install_id: "i", provider: "email", provider_sub: "acct" };
  const current = jwtWith({ ...claims, ep: "e2", iat: 1 });
  freshPhone();
  secure.set(SESSION_KEY, current);
  secure.set(USER_KEY, "{}");
  // A check-in refresh of the SAME session (its claims, epoch included) renews it.
  const renewed = jwtWith({ ...claims, ep: "e2", iat: 2 });
  await auth.rotateSessionJWT(renewed);
  assert.equal(secure.get(SESSION_KEY), renewed);
  // A refresh of an older epoch (that check-in left before a sign-in) is not stored…
  await auth.rotateSessionJWT(jwtWith({ ...claims, ep: "e1", iat: 3 }));
  assert.equal(secure.get(SESSION_KEY), renewed);
  // …nor one of another account.
  await auth.rotateSessionJWT(jwtWith({ ...claims, account_id: "other", ep: "e2" }));
  assert.equal(secure.get(SESSION_KEY), renewed);
  // Signed out meanwhile: never resurrected.
  secure.delete(SESSION_KEY);
  await auth.rotateSessionJWT(renewed);
  assert.equal(secure.has(SESSION_KEY), false);
  // A 401 for a token that has since been replaced does not sign the phone out.
  secure.set(SESSION_KEY, renewed);
  await auth.clearLocalSession({ onlyIfJwt: current });
  assert.equal(secure.get(SESSION_KEY), renewed, "the newer session stays");
  await auth.clearLocalSession({ onlyIfJwt: renewed });
  assert.equal(secure.has(SESSION_KEY), false, "the refused session ends");
  // The sync layer's 401 names the token it carried.
  const errors = load<typeof import("../sync/errors")>("../sync/errors", {});
  assert.equal(new errors.SessionExpiredError(undefined, "jwt.sent").refusedJwt, "jwt.sent");
  assert.equal(new errors.SessionExpiredError().refusedJwt, null);
});

test("session kind: Google or Apple named a subject, an email session did not", async () => {
  freshPhone();
  assert.equal(await auth.currentSessionKind(), null, "signed out");
  secure.set(SESSION_KEY, "jwt");
  secure.set(USER_KEY, JSON.stringify({ email: "a@gmail.com", sub: "google-sub" }));
  assert.equal(await auth.currentSessionKind(), "provider");
  secure.set(USER_KEY, JSON.stringify({ email: "a@example.com", has_password: true }));
  assert.equal(await auth.currentSessionKind(), "email");
});

test("names: an explicit edit reports a refusal; one that cannot be sent stays owed", async () => {
  freshPhone();
  signedIn();
  script = [reply(400, { error: "x", error_code: "invalid_name" })];
  const refused = await auth.saveAccountName("A");
  assert.equal(refused?.reason, "invalid_name");
  assert.equal(rules.accountRefusal(refused)?.field, "name");
  script = [lost];
  assert.equal(await auth.saveAccountName("Ahmad Karimi"), null, "offline is not a refusal");
  assert.equal(metaGet("account_name_pending"), "1", "check-in sends it later");
  script = [reply(200, { name: "Ahmad Karimi" })];
  assert.equal(await auth.saveAccountName("Ahmad Karimi"), null);
  assert.equal(metaGet("account_name_pending"), "");
  script = [lost];
  assert.equal(await auth.syncAccountName("Ahmad", { force: true }), false);
  assert.equal(metaGet("account_name_pending"), "1", "a forced send that never arrived stays owed");
});

test("display names: explicit provider edit updates the cached name and settles old name state", async () => {
  boundPhone("account-a");
  accountCache = "account-a";
  signedIn("jwt.a");
  secure.set(USER_KEY, JSON.stringify({ name: "Provider Name", sub: "provider-sub" }));
  metaSet("account_name_pending", "invalid");
  script = [reply(200, { name: "احمد‌ ولی" })];
  assert.equal(await auth.saveAccountDisplayName("  احمد‌ ولی  "), null);
  assert.equal(calls[0].url, BASE + "/v1/account/display-name");
  assert.deepEqual(calls[0].body, { name: "احمد‌ ولی" });
  assert.equal(calls[0].auth, "Bearer jwt.a");
  assert.deepEqual(JSON.parse(secure.get(USER_KEY)!), { name: "احمد‌ ولی", sub: "provider-sub" });
  assert.equal(await auth.accountNameState(), "settled");
});

test("display names: offline/5xx queue the exact edit for the same account; unsupported servers refuse", async () => {
  boundPhone("account-a");
  accountCache = "account-a";
  signedIn("jwt.a");
  for (const unavailable of [lost, reply(503, { error_code: "unavailable" })]) {
    script = [unavailable];
    assert.equal(await auth.saveAccountDisplayName("Chosen Name"), null);
    assert.deepEqual(JSON.parse(metaGet("account_display_name_pending")!), {
      account_id: "account-a",
      name: "Chosen Name",
    });
  }
  assert.equal(await auth.accountNameState(), "owed");
  fixture.prepare("UPDATE users SET display_name = 'Other phone name'").run();
  accountCache = "account-b";
  secure.set(SESSION_KEY, "jwt.b");
  const before = calls.length;
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, before, "another account never receives a queued rename");
  accountCache = "account-a";
  secure.set(SESSION_KEY, "jwt.renewed-a");
  script = [reply(200, { name: "Chosen Name" })];
  await auth.syncPendingAccountNameFromSelf();
  assert.deepEqual(calls.at(-1)?.body, { name: "Chosen Name" }, "retry keeps the explicit edit");
  assert.equal(calls.at(-1)?.auth, "Bearer jwt.renewed-a");
  assert.equal(metaGet("account_display_name_pending"), "");
  for (const oldServer of [reply(404, {}), reply(405, { error_code: "unavailable" })]) {
    script = [oldServer];
    const refusal = await auth.saveAccountDisplayName("Another Name");
    assert.ok(refusal && [404, 405].includes(refusal.status), "unsupported is a visible failure");
    assert.equal(metaGet("account_display_name_pending"), "");
  }
  script = [reply(400, { error_code: "invalid_name" })];
  assert.equal((await auth.saveAccountDisplayName("A"))?.reason, "invalid_name");
  assert.equal(await auth.accountNameState(), "invalid");
});

test("display names: session changes reject late cosmetics and stale retries cannot replace newer saves", async () => {
  boundPhone("account-a");
  accountCache = "account-a";
  signedIn("jwt.a");
  secure.set(USER_KEY, JSON.stringify({ name: "Old" }));
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const inFlight = new Promise<void>((done) => {
    entered = done;
  });
  script = [
    () => {
      entered();
      return new Promise<Response>((done) => {
        finish = done;
      });
    },
  ];
  const old = auth.saveAccountDisplayName("Old Intent");
  await inFlight;
  // A check-in captures the old intent while the new save waits for this send.
  const newer = auth.saveAccountDisplayName("New Intent");
  const retry = auth.syncPendingAccountNameFromSelf();
  script = [reply(200, { name: "Canonical New Intent" })];
  finish(new Response(JSON.stringify({ name: "Old Intent" }), { status: 200 }));
  await Promise.all([old, newer, retry]);
  assert.equal(calls.length, 2, "the queued old retry is superseded");
  assert.deepEqual(calls[1].body, { name: "New Intent" });
  assert.equal(JSON.parse(secure.get(USER_KEY)!).name, "Canonical New Intent");

  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  script = [
    () => {
      entered();
      return new Promise<Response>((done) => {
        finish = done;
      });
    },
  ];
  const stale = auth.saveAccountDisplayName("For A");
  await waiting;
  accountCache = "account-b";
  secure.set(SESSION_KEY, "jwt.b");
  secure.set(USER_KEY, JSON.stringify({ name: "B Name" }));
  finish(new Response(JSON.stringify({ name: "For A" }), { status: 200 }));
  assert.equal((await stale)?.reason, "session_expired");
  assert.equal(JSON.parse(secure.get(USER_KEY)!).name, "B Name");

  for (const failure of ["network", "503"] as const) {
    accountCache = "account-a";
    signedIn("jwt.a");
    let refuse!: (err: Error) => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    script = [
      () => {
        entered();
        return new Promise<Response>((done, reject) => {
          finish = done;
          refuse = reject;
        });
      },
    ];
    const offlineStale = auth.saveAccountDisplayName("Still Only For A");
    await started;
    accountCache = "account-b";
    signedIn("jwt.b");
    if (failure === "network") refuse(new TypeError("Network request failed"));
    else finish(new Response(JSON.stringify({ error_code: "unavailable" }), { status: 503 }));
    assert.equal(
      (await offlineStale)?.reason,
      "session_expired",
      `late ${failure} cannot claim a current save`,
    );
  }

  // Pin the gap between reading A's pending intent and capturing the retry's
  // session: a raw queue match must not let that intent become a B rename.
  accountCache = "account-a";
  signedIn("jwt.a");
  metaSet(
    "account_display_name_pending",
    JSON.stringify({ account_id: "account-a", name: "Only For A" }),
  );
  accountCacheReadHook = () => {
    accountCacheReadHook = null;
    accountCache = "account-b";
    secure.set(SESSION_KEY, "jwt.b");
    return "account-a";
  };
  const before = calls.length;
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, before, "the queued account remains authoritative across capture gap");
});

test("rules: a handle's @, and account names", async () => {
  assert.equal(rules.normalizeIdentifierInput(" @ali_shop "), "ali_shop");
  assert.equal(rules.normalizeIdentifierInput("@ali@shop.af"), "@ali@shop.af", "two @: as typed");
  assert.equal(rules.normalizeIdentifierInput("ali@shop.af"), "ali@shop.af");
  assert.equal(rules.normalizeIdentifierInput("@۱۲۳abc"), "123abc");
  assert.equal(rules.normalizeAccountName("  Ahmad \n  Karimi "), "Ahmad Karimi");
  assert.equal(rules.accountNameProblem("A"), "invalid");
  assert.equal(rules.accountNameProblem(" A\u200c "), "invalid", "invisible marks do not count");
  assert.equal(rules.accountNameProblem("Al"), null);
  assert.equal(rules.accountNameProblem("x".repeat(60)), null);
  assert.equal(rules.accountNameProblem("x".repeat(61)), "invalid");
  assert.equal(rules.accountNameProblem("احمد"), null);
});

test("a provider token's life is its own: a phone clock hours off does not refuse it", async () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    reactNative.Platform.OS = "android";
    // Issued by the provider's clock, valid an hour; the phone runs 3 h ahead.
    const issued = Math.floor(clock / 1000);
    clock += 3 * 3600_000;
    boundPhone("acct-old");
    googleResult = {
      type: "success",
      data: { idToken: jwtWith({ sub: "g", iat: issued, exp: issued + 3600 }) },
    };
    script = [differentAccount, reply(200, session("acct-g", "g@gmail.com", { sub: "g" }))];
    await auth.signInWithGoogle(prompter("keep").prompt);
    assert.equal(calls.length, 2, "Keep goes ahead");
    assert.equal(metaGet("account_id"), "acct-g");
    // The same hour-long token, but the question stayed up 59.5 minutes.
    boundPhone("acct-old");
    googleResult = {
      type: "success",
      data: { idToken: jwtWith({ sub: "g", iat: 1_000_000, exp: 1_003_600 }) },
    };
    script = [differentAccount];
    const slow = async () => {
      clock += 59.5 * 60_000;
      return "wipe" as const;
    };
    const err = await rejection(auth.signInWithGoogle(slow));
    assert.ok(err instanceof auth.SignInFailedError && err.stage === "token_expired");
    assert.equal(calls.length, 1, "nothing resent");
    assert.equal(trace.includes("resetAllLocalData"), false, "refused before any wipe");
    assert.equal(metaGet("account_id"), "acct-old");
  } finally {
    Date.now = realNow;
  }
});

test("Start fresh judges the OLDEST code still in play, not the newest", async () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  const send = async (email: string) => {
    script = [reply(200, { status: "sent", resend_after_s: 60 })];
    await auth.emailSignUpStart(email, "en");
    return JSON.parse(metaGet(PENDING_KEY) ?? "{}");
  };
  try {
    boundPhone("acct-old");
    const t0 = clock;
    await send("new@example.com");
    clock = t0 + 9 * 60_000;
    const stored = await send("new@example.com");
    assert.equal(stored.sent_at, t0 + 9 * 60_000, "the newest send: countdown and reopen");
    assert.equal(stored.first_sent_at, t0, "the oldest code still in play");
    assert.equal((await auth.readEmailFlowPending())?.sentAt, t0 + 9 * 60_000);
    clock = t0 + 15 * 60_000 + 10_000;
    script = [differentAccount];
    const err = await rejection(
      auth.emailSignUpVerify(
        { email: "new@example.com", code: "123456", password: "Kabul-tea-77", lang: "en" },
        { onDifferentAccount: prompter("wipe").prompt },
      ),
    );
    assert.ok(err instanceof auth.SignInFailedError && err.stage === "token_expired");
    assert.equal(trace.includes("resetAllLocalData"), false, "nothing wiped");
    // Another address starts over; a send past its 15 minutes drops out; only
    // the newest three count (the server accepts no more).
    clock = t0 + 16 * 60_000;
    assert.deepEqual((await send("other@example.com")).sends, [clock]);
    clock = t0 + 25 * 60_000;
    assert.equal((await send("other@example.com")).first_sent_at, t0 + 16 * 60_000);
    clock = t0 + 32 * 60_000;
    assert.equal((await send("other@example.com")).first_sent_at, t0 + 25 * 60_000, "expired");
    clock = t0 + 33 * 60_000;
    await send("other@example.com");
    clock = t0 + 34 * 60_000;
    const four = await send("other@example.com");
    assert.equal(four.sends.length, 3);
    assert.equal(four.first_sent_at, t0 + 32 * 60_000, "the newest three");
  } finally {
    Date.now = realNow;
  }
});

test("automatic name sends fit the server's rule; an unusable name waits for the user", async () => {
  const long = "Haji Mohammad Abdul Rahman Karimi, owner of the Mandawi wholesale market stall 45";
  assert.equal(long.length, 81);
  boundPhone("acct-email");
  signedIn("jwt.e");
  const selfName = (name: string) =>
    fixture.prepare("UPDATE users SET display_name = ? WHERE id = 'self'").run(name);
  selfName(long);
  metaSet("account_name_pending", "1");
  script = [
    (call) => {
      assert.deepEqual(call.body, {
        name: "Haji Mohammad Abdul Rahman Karimi, owner of the Mandawi",
      });
      return reply(200, { name: "cut" })();
    },
  ];
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, 1, "cut at the last word boundary within 60, and sent");
  assert.equal(await auth.accountNameState(), "settled");
  // "M" cannot be an account's name: nothing is sent, and Account asks for one.
  selfName("M");
  metaSet("account_name_pending", "1");
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, 1, "nothing sent");
  assert.equal(metaGet("account_name_pending"), "invalid");
  assert.equal(await auth.accountNameState(), "invalid", "Account shows the name error");
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(calls.length, 1, "check-in does not retry it: it is the user's to fix");
  // A refused automatic send is not swallowed either.
  selfName("Ahmad");
  metaSet("account_name_pending", "1");
  script = [reply(400, { error: "x", error_code: "invalid_name" })];
  await auth.syncPendingAccountNameFromSelf();
  assert.equal(await auth.accountNameState(), "invalid");
  // A valid save settles it.
  script = [reply(200, { name: "Ahmad Karimi" })];
  assert.equal(await auth.saveAccountName("Ahmad Karimi"), null);
  assert.equal(await auth.accountNameState(), "settled");
  // provider_name answering an explicit save is no failure: settled, no refusal.
  metaSet("account_name_pending", "1");
  script = [reply(409, { error: "x", error_code: "provider_name" })];
  assert.equal(await auth.saveAccountName("Ahmad K"), null);
  assert.equal(await auth.accountNameState(), "settled");
});

test("rules: whose name it is, and a name fitted for an automatic send", async () => {
  assert.equal(rules.accountNameIsOurs(["email"], "email"), true);
  assert.equal(rules.accountNameIsOurs(["google", "email"], "email"), false, "a Google account");
  assert.equal(rules.accountNameIsOurs(["apple"], "provider"), false);
  assert.equal(rules.accountNameIsOurs(null, "email"), true, "unknown account: the session");
  assert.equal(rules.accountNameIsOurs(null, "provider"), false);
  assert.equal(rules.accountNameIsOurs(null, null), false);
  assert.equal(rules.fitAccountName("  Ahmad   Karimi "), "Ahmad Karimi");
  assert.equal(rules.fitAccountName("M"), null);
  assert.equal(rules.fitAccountName("x".repeat(70)), "x".repeat(60), "no boundary: a hard cut");
  const exact = `${"a".repeat(30)} ${"b".repeat(29)} tail`;
  assert.equal(rules.fitAccountName(exact), `${"a".repeat(30)} ${"b".repeat(29)}`, "whole words");
});

// --- components, rendered with a hook-slot React stub ------------------------------
// One store per component under test: useState and useRef by call order,
// useEffect run after each render when its deps changed (the previous cleanup
// first), forwardRef as a plain call. A render repeats until no effect changed
// state, like a commit followed by its effects.

function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  const node = tree as Node | null;
  return node?.props ? [node, ...nodes(node.props.children)] : [];
}

const sameDeps = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function hookStore() {
  let slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  let dirty = false;
  const react = {
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (next: unknown) => {
          const value =
            typeof next === "function" ? (next as (v: unknown) => unknown)(slots[i]) : next;
          if (Object.is(value, slots[i])) return;
          slots[i] = value;
          dirty = true;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const i = cursor++;
      return (slots[i] ??= { current: initial });
    },
    useEffect: (run: () => void | (() => void), deps?: unknown[]) => {
      const i = cursor++;
      const previous = slots[i] as { deps?: unknown[]; cleanup?: () => void } | undefined;
      if (previous && sameDeps(previous.deps, deps)) return;
      const slot: { deps?: unknown[]; cleanup?: () => void } = { deps };
      slots[i] = slot;
      effects.push(() => {
        previous?.cleanup?.();
        const cleanup = run();
        if (typeof cleanup === "function") slot.cleanup = cleanup;
      });
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const i = cursor++;
      const previous = slots[i] as { fn: unknown; deps?: unknown[] } | undefined;
      if (previous && sameDeps(previous.deps, deps)) return previous.fn;
      slots[i] = { fn, deps };
      return fn;
    },
    forwardRef:
      (render: (props: Record<string, unknown>, ref: unknown) => unknown) =>
      (props: Record<string, unknown>) =>
        render(props, props.ref ?? null),
  };
  function render(component: () => unknown): Node[] {
    for (let pass = 0; pass < 20; pass++) {
      cursor = 0;
      dirty = false;
      const tree = component();
      const due = effects;
      effects = [];
      for (const effect of due) effect();
      if (!dirty) return nodes(tree);
    }
    assert.fail("the component never settled");
  }
  return {
    react,
    render,
    reset: () => {
      slots = [];
      effects = [];
    },
  };
}

const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "Fragment" };
const LTR = { writingDirection: "ltr", textAlign: "left" };

// --- cold-start routing: the mounted gate, with the real stored-flow readers ---

const startupHooks = hookStore();
let startupPath = "/";
let startupNavigationReady = true;
let startupForceUpdate = false;
let startupURL: string | null = null;
let startupURLWait: Promise<string | null> | null = null;
let startupRoutes: unknown[] = [];
const startupRouter = { push: (route: unknown) => startupRoutes.push(route) };
const startup = load<typeof import("../../components/PendingEmailFlowResume")>(
  "../../components/PendingEmailFlowResume",
  {
    react: startupHooks.react,
    "expo-router": {
      usePathname: () => startupPath,
      useRootNavigationState: () => (startupNavigationReady ? { key: "root" } : undefined),
      useRouter: () => startupRouter,
    },
    "react-native": {
      Linking: { getInitialURL: () => startupURLWait ?? Promise.resolve(startupURL) },
    },
    "../lib/app-meta-context": { useAppMeta: () => ({ forceUpdate: startupForceUpdate }) },
    "../lib/auth": auth,
  },
);
type StartupProps = Parameters<typeof startup.PendingEmailFlowResume>[0];

function resetStartup() {
  startupHooks.reset();
  startupPath = "/";
  startupNavigationReady = true;
  startupForceUpdate = false;
  startupURL = null;
  startupURLWait = null;
  startupRoutes = [];
}

function renderStartup(over: Partial<StartupProps> = {}) {
  startupHooks.render(() =>
    startup.PendingEmailFlowResume({
      hasOnboarded: true,
      launchNotificationsReady: true,
      launchNotificationOpened: false,
      ...over,
    }),
  );
}

function pendingStartup(purpose: "signup" | "reset" | "setup", over = {}) {
  metaSet(
    PENDING_KEY,
    JSON.stringify({ purpose, email: "code@example.com", sent_at: Date.now(), ...over }),
  );
}

test("cold start: onboarded offline reset navigates from / once, after launch routing", async () => {
  const install = boundPhone();
  resetStartup();
  pendingStartup("reset");
  startupNavigationReady = false;
  renderStartup({ launchNotificationsReady: false });
  await settle();
  assert.deepEqual(startupRoutes, [], "never navigate before the Stack is ready");
  startupNavigationReady = true;
  renderStartup({ launchNotificationsReady: false });
  await settle();
  assert.deepEqual(startupRoutes, [], "launch notification inspection has priority");
  renderStartup();
  await settle();
  assert.deepEqual(startupRoutes, [{ pathname: "/sign-in", params: { mode: "email" } }]);
  startupPath = "/sign-in";
  renderStartup();
  startupPath = "/";
  renderStartup();
  await settle();
  assert.equal(startupRoutes.length, 1, "Back and rerenders do not reopen the flow");
  assert.equal(metaGet("install_id"), install, "resuming never replaces the install");
  const people = fixture.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  assert.equal(people.n, 1);
});

test("cold start: fresh signup/reset survives Home's default onboarding redirect", async () => {
  for (const purpose of ["signup", "reset"] as const) {
    freshPhone();
    resetStartup();
    pendingStartup(purpose);
    let release!: (url: string | null) => void;
    startupURLWait = new Promise((resolve) => {
      release = resolve;
    });
    renderStartup({ hasOnboarded: false });
    startupPath = "/onboarding/language";
    renderStartup({ hasOnboarded: false });
    release(null);
    await settle();
    assert.deepEqual(startupRoutes, ["/onboarding/auth"], purpose);
  }
});

test("cold start: cleared/expired steps and existing signed-in flows do not route", async () => {
  for (const state of ["expired", "cancelled", "finished", "signed-in"] as const) {
    boundPhone();
    resetStartup();
    pendingStartup("reset", {
      sent_at: state === "expired" ? Date.now() - auth.EMAIL_CODE_TTL_MS : Date.now(),
    });
    if (state === "cancelled" || state === "finished") await auth.clearEmailFlowPending();
    if (state === "finished" || state === "signed-in") signedIn();
    renderStartup();
    await settle();
    assert.deepEqual(startupRoutes, [], state);
    if (state !== "signed-in") assert.equal(await auth.readEmailFlowPending(), null, state);
  }
});

test("cold start: setup resumes only the current signed-in account's password screen", async () => {
  for (const state of ["matching", "different", "no-account", "no-session", "legacy"] as const) {
    freshPhone();
    resetStartup();
    if (state !== "no-account") metaSet("account_id", "acct-current");
    if (state !== "no-session") signedIn();
    pendingStartup("setup", {
      account_id: state === "legacy" ? null : state === "different" ? "acct-other" : "acct-current",
    });
    renderStartup();
    await settle();
    assert.deepEqual(startupRoutes, state === "matching" ? ["/account-password"] : [], state);
    if (state === "different" || state === "no-account" || state === "legacy")
      assert.equal(await auth.readEmailFlowPending(), null, `${state}: forgotten`);
  }
});

test("cold start: links, notifications, update gates and active screens keep their route", async () => {
  for (const intent of [
    "deep-link",
    "onboarding-link",
    "notification",
    "update",
    "screen",
  ] as const) {
    boundPhone();
    resetStartup();
    pendingStartup("reset");
    if (intent === "deep-link") startupPath = "/person/a";
    if (intent === "onboarding-link") {
      startupPath = "/onboarding/auth";
      startupURL = "kaata://onboarding/auth";
    }
    if (intent === "update") startupForceUpdate = true;
    if (intent === "screen") startupPath = "/account";
    renderStartup({ launchNotificationOpened: intent === "notification" });
    await settle();
    assert.deepEqual(startupRoutes, [], intent);
    startupPath = "/";
    startupURL = null;
    startupForceUpdate = false;
    renderStartup();
    await settle();
    assert.deepEqual(startupRoutes, [], `${intent}: no later takeover`);
  }
});

test("cold start: new launch routing or an update while storage is read cancels resume", async () => {
  for (const change of ["route", "update", "notification"] as const) {
    boundPhone();
    resetStartup();
    pendingStartup("reset");
    let release!: (url: string | null) => void;
    startupURLWait = new Promise((resolve) => {
      release = resolve;
    });
    renderStartup();
    if (change === "route") startupPath = "/person/a";
    if (change === "update") startupForceUpdate = true;
    renderStartup({ launchNotificationOpened: change === "notification" });
    release(null);
    await settle();
    assert.deepEqual(startupRoutes, [], change);
  }
});

test("cold start: the real root layout mounts the resume gate beside its Stack", async () => {
  const layout = ts.createSourceFile(
    "_layout.tsx",
    readFileSync(require.resolve("../../app/_layout"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let mounted = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(layout) === "AppMetaProvider"
    ) {
      const tags = node.children.filter(ts.isJsxElement);
      const stack = tags.find((tag) => tag.openingElement.tagName.getText(layout) === "Stack");
      const gate = node.children.find(
        (child) =>
          ts.isJsxSelfClosingElement(child) &&
          child.tagName.getText(layout) === "PendingEmailFlowResume",
      );
      mounted = Boolean(stack && gate && gate.pos > stack.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(layout);
  assert.ok(mounted, "a functional gate must be mounted after the actual root Stack");
});

// Timers the components schedule run by hand, so a focus or a countdown is a
// step of the case rather than a race with it.
type Timer = { fn: () => void; ms: number; repeat: boolean; cleared: boolean };
let timers: Timer[] = [];

function componentTest(name: string, run: () => Promise<void>) {
  test(name, async () => {
    const real = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    timers = [];
    const add = (repeat: boolean) => (fn: () => void, ms?: number) => {
      const timer: Timer = { fn, ms: ms ?? 0, repeat, cleared: false };
      timers.push(timer);
      return timer;
    };
    const clear = (timer?: Timer) => {
      if (timer) timer.cleared = true;
    };
    Object.assign(globalThis, {
      setTimeout: add(false),
      clearTimeout: clear,
      setInterval: add(true),
      clearInterval: clear,
    });
    try {
      await run();
    } finally {
      Object.assign(globalThis, real);
    }
  });
}

const textOf = (node: Node) => ([] as unknown[]).concat(node.props.children ?? []).join("");
const texts = (tree: Node[]) => tree.filter((n) => n.type === "Text").map(textOf);
const control = (tree: Node[], label: string) =>
  tree.find((n) => n.props.accessibilityLabel === label);

componentTest("PasswordField: hidden at first, a labelled show/hide toggle, LTR", async () => {
  const hooks = hookStore();
  const mod = load<{ PasswordField: (props: Record<string, unknown>) => unknown }>(
    "../../components/PasswordField",
    {
      "react/jsx-runtime": jsxRuntime,
      "@expo/vector-icons": { Ionicons: "Icon" },
      react: hooks.react,
      "react-native": { Pressable: "Pressable", StyleSheet: { create: (x: unknown) => x } },
      "../lib/colors": { colors: {} },
      "../lib/i18n": { t: keyT },
      "../lib/tokens": { TOUCH_MIN: 44 },
      "./FormField": { FormField: "FormField", LTR_INPUT: LTR },
    },
  );
  const render = () =>
    hooks.render(() =>
      mod.PasswordField({ label: "auth.email.password", value: "x", style: { marginTop: 1 } }),
    );
  let [field] = render();
  assert.equal(field.type, "FormField");
  assert.equal(field.props.secureTextEntry, true, "hidden at first");
  assert.deepEqual(field.props.style, [LTR, { marginTop: 1 }], "LTR, the caller's style last");
  assert.equal(field.props.autoCorrect, false);
  assert.equal(field.props.autoCapitalize, "none");
  assert.equal(field.props.accessory.props.accessibilityLabel, "auth.password.show");
  field.props.accessory.props.onPress();
  [field] = render();
  assert.equal(field.props.secureTextEntry, false, "shown");
  assert.equal(field.props.accessory.props.accessibilityLabel, "auth.password.hide");
});

// --- EmailAuthFlow --------------------------------------------------------------

type AuthCall = { fn: string; args: unknown[] };
let authCalls: AuthCall[] = [];
// One answer per lib/auth call the flow makes, in order.
let authAnswers: Array<() => Promise<unknown>> = [];
const answer = (value: unknown) => async () => value;
const fail = (err: unknown) => async () => {
  throw err;
};
function spy(fn: string) {
  return (...args: unknown[]) => {
    authCalls.push({ fn, args });
    const next = authAnswers.shift();
    if (!next) throw new Error(`unscripted ${fn}`);
    return next();
  };
}

const flowHooks = hookStore();
const flowModule = load<{ EmailAuthFlow: (props: Record<string, unknown>) => unknown }>(
  "../../components/EmailAuthFlow",
  {
    "react/jsx-runtime": jsxRuntime,
    "@expo/vector-icons": { Ionicons: "Icon" },
    react: flowHooks.react,
    "react-native": {
      ActivityIndicator: "Spinner",
      Pressable: "Pressable",
      StyleSheet: { create: (x: unknown) => x },
      Text: "Text",
      View: "View",
    },
    // The REAL rules, worded by key.
    "../lib/account-rules": keyRules,
    "../lib/auth": {
      clearEmailFlowPending: async () => {
        authCalls.push({ fn: "clearEmailFlowPending", args: [] });
      },
      emailResetStart: spy("emailResetStart"),
      emailResetVerify: spy("emailResetVerify"),
      emailSignIn: spy("emailSignIn"),
      emailSignUpStart: spy("emailSignUpStart"),
      emailSignUpVerify: spy("emailSignUpVerify"),
      // The REAL ones, so a cancel and a timeout are the shipped ones.
      isCancellation: auth.isCancellation,
      SignInFailedError: auth.SignInFailedError,
    },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      // Visible isolation, so a case can see an address was isolated.
      ltrIsolate: (value: string) => `<${value}>`,
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
    },
    "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, tight: number) => tight },
    "../lib/i18n": { t: keyT, getLocale: () => "en" },
    "../lib/tokens": { TOUCH_MIN: 44, typography: {} },
    "./Button": { Button: "Button" },
    "./FormField": { FormField: "FormField", LTR_INPUT: LTR },
    "./GoogleGIcon": { GoogleGIcon: "Google" },
    "./PasswordField": { PasswordField: "PasswordField" },
    "./PasswordRules": { PasswordRules: "PasswordRules" },
  },
);

const PROMPT = async () => "keep" as const;
const backRef: { current: (() => boolean) | null } = { current: null };
let flowProps: Record<string, unknown> = {};
let flowEvents: string[] = [];
let signedInUsers: unknown[] = [];
let failures: unknown[] = [];

const renderFlow = () => flowHooks.render(() => flowModule.EmailAuthFlow(flowProps));

function mountFlow(over: Record<string, unknown> = {}): Node[] {
  flowHooks.reset();
  authCalls = [];
  authAnswers = [];
  flowEvents = [];
  signedInUsers = [];
  failures = [];
  backRef.current = null;
  flowProps = {
    entry: "signup",
    resume: null,
    isRTL: false,
    busy: false,
    googleAvailable: true,
    focusInput: () => {},
    blurInput: () => {},
    run: async (task: () => Promise<void>) => {
      flowEvents.push("run");
      await task();
    },
    onSignedIn: async (user: unknown) => {
      signedInUsers.push(user);
    },
    onFailure: (err: unknown) => {
      failures.push(err);
    },
    onGoogle: () => flowEvents.push("google"),
    onExit: () => flowEvents.push("exit"),
    promptDifferentAccount: PROMPT,
    // AuthScreen's failure text and reset: placed on the form.
    notice: { type: "Notice", props: {} },
    backRef,
    ...over,
  };
  return renderFlow();
}

function field(tree: Node[], label: string): Node {
  const found = tree.find(
    (n) => (n.type === "FormField" || n.type === "PasswordField") && n.props.label === label,
  );
  assert.ok(found, `no field labelled ${label}`);
  return found;
}

function type(label: string, value: string): Node[] {
  field(renderFlow(), label).props.onChangeText(value);
  return renderFlow();
}

async function press(label: string): Promise<Node[]> {
  const found = control(renderFlow(), label);
  assert.ok(found, `no control labelled ${label}`);
  await found.props.onPress();
  await settle();
  return renderFlow();
}

async function submit(): Promise<Node[]> {
  const button = renderFlow().find((n) => n.type === "Button");
  assert.ok(button, "every step has its button");
  await button.props.onPress();
  await settle();
  return renderFlow();
}

// Sign-up with a valid address and password, landing on the code step.
async function toCodeStep(): Promise<Node[]> {
  mountFlow({ entry: "signup" });
  type("auth.email.email", "a@example.com");
  type("auth.email.newPassword", "Kabul-tea-77");
  authAnswers = [answer({ resendAfterS: 60 })];
  await submit();
  const tree = type("auth.email.code.label", "123456");
  authCalls = [];
  return tree;
}

componentTest("flow, sign-up step: email and a NEW Kaata password, LTR, rules shown", async () => {
  const tree = mountFlow({ entry: "signup" });
  const email = field(tree, "auth.email.email");
  assert.deepEqual(email.props.style, LTR, "an address is LTR in both languages");
  assert.equal(email.props.keyboardType, "email-address");
  assert.equal(email.props.autoCapitalize, "none");
  const password = field(tree, "auth.email.newPassword");
  assert.equal(password.type, "PasswordField", "a show/hide toggle");
  assert.equal(password.props.autoComplete, "new-password");
  assert.ok(texts(tree).includes("auth.email.newPassword.helper"), "not your Gmail password");
  assert.equal(tree.find((n) => n.type === "PasswordRules")?.props.value, "");
  assert.equal(tree.find((n) => n.type === "Button")?.props.label, "auth.email.sendCode");
  assert.ok(control(tree, "auth.email.toSignIn"), "sign-up offers sign-in");
  assert.ok(
    tree.some((n) => n.type === "Notice"),
    "AuthScreen's notice sits on the form",
  );
  assert.equal(
    tree.some((n) => n.type === "ScrollView"),
    false,
    "no ScrollView of its own",
  );
  assert.equal(
    tree.some((n) => "autoFocus" in n.props),
    false,
    "never autoFocus",
  );
  // "Already have an account? Sign in" sits under the title, ABOVE the fields,
  // and only once.
  const signIn = tree.findIndex((n) => n.props.accessibilityLabel === "auth.email.toSignIn");
  assert.ok(signIn >= 0 && signIn < tree.indexOf(email), "the way in comes before the fields");
  assert.equal(
    tree.filter((n) => n.props.accessibilityLabel === "auth.email.toSignIn").length,
    1,
    "offered once",
  );
  // The FIRST step never opens the keyboard by itself (it would hide the step).
  assert.equal(
    timers.some((t) => !t.repeat && t.ms === 280),
    false,
    "nothing focused on the first step",
  );
  mountFlow({ entry: "signin" });
  assert.equal(
    timers.some((t) => !t.repeat && t.ms === 280),
    false,
    "on either entry",
  );
});

componentTest(
  "flow: on SIGN-UP only, a Gmail address offers Google instead of a password",
  async () => {
    mountFlow({ entry: "signup" });
    let tree = type("auth.email.email", " Ahmad@Gmail.com");
    const google = control(tree, "auth.email.gmail");
    assert.ok(google, "offered under a Gmail address");
    google.props.onPress();
    assert.deepEqual(flowEvents, ["google"]);
    tree = type("auth.email.email", "a@googlemail.com");
    assert.ok(control(tree, "auth.email.gmail"), "googlemail.com too");
    tree = type("auth.email.email", "ahmad@yahoo.com");
    assert.equal(control(tree, "auth.email.gmail"), undefined);
    mountFlow({ entry: "signup", googleAvailable: false });
    tree = type("auth.email.email", "a@gmail.com");
    assert.equal(control(tree, "auth.email.gmail"), undefined, "not where Google cannot sign in");
    // Never on SIGN-IN: a Gmail review account would be steered to Android's
    // device-bound Google sign-in, the path Play rejected (build 49).
    mountFlow({ entry: "signin" });
    tree = type("auth.email.identifier", "kaata.review@gmail.com");
    assert.equal(control(tree, "auth.email.gmail"), undefined, "not under a sign-in");
    // The sign-in step's way to Google and Apple is the invalid_credentials hint.
    type("auth.email.password", "wrong-one");
    authAnswers = [fail(new auth.EmailAuthError("invalid_credentials", 401))];
    tree = await submit();
    assert.ok(control(tree, "auth.email.providerHint"));
    assert.equal(control(tree, "auth.email.gmail"), undefined);
  },
);

componentTest("flow, sign-up: the cheap checks refuse before any request", async () => {
  mountFlow({ entry: "signup" });
  let tree = await submit();
  assert.equal(field(tree, "auth.email.email").props.error, "auth.email.required");
  assert.equal(field(tree, "auth.email.newPassword").props.error, "auth.error.password.too_short");
  type("auth.email.email", "x@privaterelay.appleid.com");
  type("auth.email.newPassword", "12345678");
  tree = await submit();
  assert.equal(field(tree, "auth.email.email").props.error, "auth.error.email.relay");
  assert.equal(field(tree, "auth.email.newPassword").props.error, "auth.error.password.pattern");
  assert.equal(authCalls.length, 0, "nothing was sent");
  tree = type("auth.email.email", "a@example.com");
  assert.equal(field(tree, "auth.email.email").props.error, null, "typing clears its own error");
  assert.equal(field(tree, "auth.email.newPassword").props.error, "auth.error.password.pattern");
});

componentTest("flow, sign-up → code: the request, the code step, then the account", async () => {
  mountFlow({ entry: "signup" });
  type("auth.email.email", " A@Example.com ");
  type("auth.email.newPassword", "Kabul-tea-77");
  authAnswers = [answer({ resendAfterS: 75 })];
  let tree = await submit();
  assert.deepEqual(authCalls[0], { fn: "emailSignUpStart", args: ["A@Example.com", "en"] });
  const code = field(tree, "auth.email.code.label");
  // A step the user moved to is focused: ref + setTimeout(280), never autoFocus.
  const focus = timers.find((t) => !t.repeat && t.ms === 280 && !t.cleared);
  assert.ok(focus, "the code field is focused 280 ms out");
  let focused = 0;
  code.props.ref.current = { focus: () => focused++ };
  focus.fn();
  assert.equal(focused, 1);
  // A returning user whose address already has an account gets a notice
  // instead of a code: the way in is offered right on this step.
  assert.ok(control(tree, "auth.email.toSignIn"), "the sign-up code step offers sign-in");
  assert.equal(code.props.keyboardType, "number-pad");
  assert.deepEqual(code.props.style[0], LTR, "the code is LTR");
  assert.equal(code.props.textContentType, "oneTimeCode");
  assert.ok(
    texts(tree).some((s) => s.startsWith("auth.email.code.sent") && s.includes("<A@Example.com>")),
    "the address, isolated",
  );
  assert.ok(texts(tree).includes(`auth.email.code.resendIn {"time":"<1:15>"}`), "resend_after_s");
  assert.ok(texts(tree).includes("auth.email.code.spam"), "check Spam");
  assert.ok(control(tree, "auth.email.code.changeEmail"));
  assert.equal(tree.find((n) => n.type === "Button")?.props.label, "auth.email.code.submit");
  assert.equal(
    tree.some((n) => n.props.label === "auth.email.newPassword"),
    false,
    "the password typed a moment ago is still in memory",
  );
  assert.ok(
    timers.some((t) => t.repeat && t.ms === 1000 && !t.cleared),
    "the countdown ticks",
  );
  tree = type("auth.email.code.label", "۱۲۳-٤٥٦ 7");
  assert.equal(field(tree, "auth.email.code.label").props.value, "123456", "digits folded");
  authAnswers = [answer({ email: "a@example.com" })];
  await submit();
  assert.equal(authCalls[1].fn, "emailSignUpVerify");
  assert.deepEqual(authCalls[1].args, [
    { email: "A@Example.com", code: "123456", password: "Kabul-tea-77", lang: "en" },
    { onDifferentAccount: PROMPT, afterTimeout: false },
  ]);
  assert.deepEqual(signedInUsers, [{ email: "a@example.com" }], "AuthScreen completes it");
  assert.deepEqual(failures, []);
});

componentTest("flow, code step: each refusal lands where it belongs", async () => {
  let tree = await toCodeStep();
  authAnswers = [fail(new auth.EmailAuthError("invalid_code", 401))];
  tree = await submit();
  assert.equal(field(tree, "auth.email.code.label").props.error, "auth.error.code.invalid");
  assert.deepEqual(failures, [], "a refusal is worded here, not reported");
  // A password only the server can refuse (common, personal): asked again here.
  authAnswers = [fail(new auth.EmailAuthError("weak_password", 400, { reason: "common" }))];
  tree = await submit();
  const again = field(tree, "auth.email.newPassword");
  assert.equal(again.type, "PasswordField");
  assert.equal(again.props.error, "auth.error.password.common");
  // A lost reply goes to AuthScreen, and the next verify says it may have landed.
  type("auth.email.newPassword", "Kabul-tea-78");
  authAnswers = [fail(new auth.SignInFailedError("timeout", "slow"))];
  await submit();
  assert.equal(failures.length, 1, "AuthScreen words a timeout");
  authAnswers = [answer({ email: "a@example.com" })];
  await submit();
  const verify = authCalls.filter((c) => c.fn === "emailSignUpVerify").at(-1);
  assert.deepEqual(verify?.args[1], { onDifferentAccount: PROMPT, afterTimeout: true });
  assert.equal((verify?.args[0] as { password: string }).password, "Kabul-tea-78");
  // A cancelled "different account?" is the user's answer: nothing to show.
  tree = await toCodeStep();
  authAnswers = [fail(new auth.SignInCancelledByUserError())];
  tree = await submit();
  assert.deepEqual(failures, []);
  assert.equal(
    tree.some((n) => n.props.accessibilityLiveRegion === "polite"),
    false,
  );
  // The address has an account: say so, and offer the way in.
  authAnswers = [fail(new auth.EmailAuthError("account_exists", 409))];
  tree = await submit();
  assert.ok(texts(tree).includes("auth.error.accountExists"));
  tree = await press("auth.email.toSignIn");
  assert.equal(field(tree, "auth.email.identifier").props.value, "a@example.com");
  assert.ok(
    authCalls.some((c) => c.fn === "clearEmailFlowPending"),
    "the code step is forgotten",
  );
});

componentTest(
  "flow, sign-in: identifier and password; invalid_credentials points back",
  async () => {
    let tree = mountFlow({ entry: "signin" });
    assert.deepEqual(field(tree, "auth.email.identifier").props.style, LTR);
    assert.equal(field(tree, "auth.email.password").type, "PasswordField");
    assert.ok(control(tree, "auth.email.forgot") && control(tree, "auth.email.toSignUp"));
    tree = await submit();
    assert.equal(field(tree, "auth.email.identifier").props.error, "auth.email.identifierRequired");
    assert.equal(field(tree, "auth.email.password").props.error, "auth.email.passwordRequired");
    assert.equal(authCalls.length, 0);
    type("auth.email.identifier", " ahmad_k ");
    type("auth.email.password", " pw secret ");
    authAnswers = [fail(new auth.EmailAuthError("invalid_credentials", 401))];
    tree = await submit();
    assert.deepEqual(authCalls[0].args, ["ahmad_k", " pw secret ", { onDifferentAccount: PROMPT }]);
    assert.ok(texts(tree).includes("auth.error.invalidCredentials"));
    const hint = control(tree, "auth.email.providerHint");
    assert.ok(hint, "Joined with Google or Apple? Use that button.");
    hint.props.onPress();
    assert.ok(flowEvents.includes("exit"), "back to the provider buttons");
    authAnswers = [fail(new auth.EmailAuthError("too_many_attempts", 429, { retryAfterS: 600 }))];
    tree = await submit();
    assert.ok(
      texts(tree).some((s) => s.startsWith("auth.error.tooManyAttempts.wait")),
      "the wait is shown",
    );
    authAnswers = [answer({ email: "a@example.com" })];
    await submit();
    assert.equal(signedInUsers.length, 1);
  },
);

componentTest("flow, forgot → reset: a code and a new password, then signed in", async () => {
  mountFlow({ entry: "signin" });
  type("auth.email.identifier", "a@example.com");
  let tree = await press("auth.email.forgot");
  assert.equal(field(tree, "auth.email.email").props.value, "a@example.com", "carried over");
  authAnswers = [answer({ resendAfterS: 60 })];
  tree = await submit();
  assert.deepEqual(authCalls[0], { fn: "emailResetStart", args: ["a@example.com", "en"] });
  assert.ok(texts(tree).some((s) => s.startsWith("auth.email.reset.sent")));
  assert.equal(field(tree, "auth.email.reset.newPassword").type, "PasswordField");
  assert.ok(tree.some((n) => n.type === "PasswordRules"));
  type("auth.email.code.label", "654321");
  type("auth.email.reset.newPassword", "New-pass-99");
  authAnswers = [answer({ email: "a@example.com" })];
  await submit();
  assert.deepEqual(authCalls[1].args, [
    { email: "a@example.com", code: "654321", newPassword: "New-pass-99", lang: "en" },
    { onDifferentAccount: PROMPT, afterTimeout: false },
  ]);
  assert.equal(signedInUsers.length, 1);
  // Change email from the reset step: back to forgot, the code step forgotten.
  mountFlow({ entry: "signin" });
  type("auth.email.identifier", "a@example.com");
  await press("auth.email.forgot");
  authAnswers = [answer({ resendAfterS: 60 })];
  await submit();
  tree = await press("auth.email.code.changeEmail");
  assert.ok(field(tree, "auth.email.email"), "the forgot step");
  assert.ok(authCalls.some((c) => c.fn === "clearEmailFlowPending"));
});

componentTest("flow: Back retraces the steps; leaving a code step forgets it", async () => {
  await toCodeStep();
  renderFlow();
  assert.equal(backRef.current?.(), true, "one step back");
  let tree = renderFlow();
  assert.equal(field(tree, "auth.email.email").props.value, "a@example.com", "kept");
  assert.ok(
    authCalls.some((c) => c.fn === "clearEmailFlowPending"),
    "the code step is forgotten",
  );
  assert.equal(backRef.current?.(), false, "the first step: AuthScreen leaves the flow");
  // Sign-in and sign-up are siblings: switching back and forth does not stack.
  mountFlow({ entry: "signin" });
  await press("auth.email.toSignUp");
  tree = await press("auth.email.toSignIn");
  assert.ok(field(tree, "auth.email.identifier"));
  assert.equal(backRef.current?.(), false);
  // Forgot sits on top of sign-in.
  mountFlow({ entry: "signin" });
  await press("auth.email.forgot");
  assert.equal(backRef.current?.(), true);
  tree = renderFlow();
  assert.ok(field(tree, "auth.email.identifier"), "back on sign-in");
});

componentTest(
  "flow: a code step the app was killed on reopens, and asks for the password",
  async () => {
    const sentAt = Date.now() - 10_000;
    let tree = mountFlow({
      entry: "signin",
      resume: { purpose: "signup", email: "a@example.com", sentAt },
    });
    assert.ok(field(tree, "auth.email.code.label"), "on the code step");
    assert.ok(texts(tree).some((s) => s.includes("<a@example.com>")));
    assert.equal(
      field(tree, "auth.email.newPassword").type,
      "PasswordField",
      "never stored, so asked again",
    );
    assert.ok(texts(tree).includes("auth.email.code.passwordAgain"));
    assert.ok(
      texts(tree).some((s) => /^auth\.email\.code\.resendIn \{"time":"<0:(4|5)\d>"\}$/.test(s)),
      "the countdown carries on from sent_at",
    );
    type("auth.email.code.label", "111111");
    type("auth.email.newPassword", "Kabul-tea-77");
    authAnswers = [answer({ email: "a@example.com" })];
    await submit();
    assert.deepEqual(authCalls[0].args[0], {
      email: "a@example.com",
      code: "111111",
      password: "Kabul-tea-77",
      lang: "en",
    });
    // A reset reopens on the reset step, above forgot.
    tree = mountFlow({
      entry: "signup",
      resume: { purpose: "reset", email: "a@example.com", sentAt },
    });
    assert.ok(field(tree, "auth.email.reset.newPassword"));
    assert.equal(backRef.current?.(), true);
    tree = renderFlow();
    assert.equal(field(tree, "auth.email.email").props.value, "a@example.com", "forgot, filled");
  },
);

componentTest("flow: resend waits for the countdown, then sends a new code", async () => {
  const sentAt = Date.now() - 120_000;
  let tree = mountFlow({ resume: { purpose: "signup", email: "a@example.com", sentAt } });
  assert.ok(control(tree, "auth.email.code.resend"), "the wait is over");
  authAnswers = [answer({ resendAfterS: 60 })];
  tree = await press("auth.email.code.resend");
  assert.deepEqual(authCalls.at(-1), { fn: "emailSignUpStart", args: ["a@example.com", "en"] });
  assert.ok(texts(tree).includes("auth.email.code.resent"));
  assert.equal(control(tree, "auth.email.code.resend"), undefined, "counting down again");
  assert.ok(texts(tree).includes(`auth.email.code.resendIn {"time":"<1:00>"}`));
  // A resend refused by the hourly window says so.
  const later = mountFlow({ resume: { purpose: "reset", email: "a@example.com", sentAt } });
  assert.ok(control(later, "auth.email.code.resend"));
  authAnswers = [
    fail(new auth.EmailAuthError("too_many_requests", 429, { retryAfterS: 1800, limit: "hour" })),
  ];
  tree = await press("auth.email.code.resend");
  assert.equal(authCalls.at(-1)?.fn, "emailResetStart");
  assert.ok(texts(tree).some((s) => s.startsWith("auth.error.tooManyEmails.wait")));
});

componentTest("flow: while any sign-in runs, nothing starts", async () => {
  let tree = mountFlow({ entry: "signin", busy: true });
  assert.equal(field(tree, "auth.email.identifier").props.editable, false);
  assert.equal(tree.find((n) => n.type === "Button")?.props.disabled, true);
  type("auth.email.identifier", "a@example.com");
  type("auth.email.password", "pw");
  tree = await submit();
  assert.equal(authCalls.length, 0);
  assert.equal(control(tree, "auth.email.forgot")?.props.disabled, true);
});

componentTest("flow: a username typed as @handle is a username, never an address", async () => {
  mountFlow({ entry: "signin" });
  type("auth.email.identifier", "@ali_shop");
  let tree = await press("auth.email.forgot");
  assert.equal(field(tree, "auth.email.email").props.value, "", "Forgot starts empty");
  mountFlow({ entry: "signin" });
  type("auth.email.identifier", "@ali_shop");
  tree = await press("auth.email.toSignUp");
  assert.equal(field(tree, "auth.email.email").props.value, "", "so does sign-up");
  mountFlow({ entry: "signin" });
  type("auth.email.identifier", " @ali_shop ");
  type("auth.email.password", "pw-secret");
  authAnswers = [answer({})];
  await submit();
  assert.equal(authCalls[0].args[0], "ali_shop", "sent as the username");
});

componentTest(
  "flow: a reopened sign-up code step offers sign-in and opens no keyboard",
  async () => {
    const sentAt = Date.now() - 10_000;
    let tree = mountFlow({
      entry: "signin",
      resume: { purpose: "signup", email: "a@example.com", sentAt, accountId: null },
    });
    assert.ok(control(tree, "auth.email.toSignIn"), "the email may say the account exists");
    assert.equal(
      timers.some((t) => !t.repeat && t.ms === 280),
      false,
      "nothing focused on the step the flow opened on",
    );
    tree = await press("auth.email.toSignIn");
    assert.equal(field(tree, "auth.email.identifier").props.value, "a@example.com");
    assert.ok(
      authCalls.some((c) => c.fn === "clearEmailFlowPending"),
      "the code step is forgotten",
    );
    // A reset is for an account that exists already: no such offer there.
    tree = mountFlow({
      entry: "signin",
      resume: { purpose: "reset", email: "a@example.com", sentAt, accountId: null },
    });
    assert.equal(control(tree, "auth.email.toSignIn"), undefined);
  },
);

// --- the onboarding name step (app/onboarding/profile.tsx) ----------------------------

const profileHooks = hookStore();
let profileMeta = new Map<string, string>();
let profileRoutes: unknown[] = [];
let nameSyncs: Array<[string, unknown]> = [];
let profileSessionKind: "provider" | "email" | null = "email";
// The account's sign-in identities, as GET /v1/account/me names them.
let profileProviders: string[] = ["email"];
const profileModule = load<{ default: () => unknown }>("../../app/onboarding/profile", {
  "react/jsx-runtime": jsxRuntime,
  react: profileHooks.react,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-router": { useRouter: () => ({ replace: (r: unknown) => profileRoutes.push(r) }) },
  "react-native": {
    Keyboard: { dismiss: () => {} },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Platform: { OS: "android" },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: (x: unknown) => x },
    Text: "Text",
    TextInput: "TextInput",
    View: "View",
  },
  "react-native-safe-area-context": { SafeAreaView: "Safe" },
  "../../components/Button": { Button: "Button" },
  "../../components/CountryPickerSheet": { CountryPickerSheet: "CountryPicker" },
  "../../components/FormField": { FormField: "FormField" },
  // The REAL rule, worded by key.
  "../../lib/account-rules": keyRules,
  "../../lib/auth": {
    currentSessionKind: async () => profileSessionKind,
    fetchAccountMe: async () => ({ providers: profileProviders }),
    syncAccountName: async (name: string, opts: unknown) => {
      nameSyncs.push([name, opts]);
      return true;
    },
  },
  "../../lib/colors": { colors: {} },
  "../../lib/db": {
    getAppMeta: async (key: string) => profileMeta.get(key) ?? null,
    setAppMeta: async (key: string, value: string) => {
      profileMeta.set(key, value);
    },
  },
  "../../lib/direction": {
    ltrIsolate: (value: string) => value,
    rowDir: () => ({}),
    textDir: () => ({}),
    trackingSafe: () => ({}),
    useIsRTL: () => false,
  },
  "../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, tight: number) => tight },
  "../../lib/i18n": { t: keyT },
  "../../lib/phone": {
    getCountry: () => ({ code: "AF", flag: "AF", dialCode: "+93" }),
    getCurrentDefaultCountryCode: () => "AF",
    inferCountryFromE164: () => "AF",
    normalizePhone: (raw: string) => (raw ? "+93700000001" : null),
  },
  "../../lib/tokens": { icon: {}, radius: {}, TOUCH_MIN: 44, typography: {} },
  "../../lib/use-onboarding-keyboard-scroll": {
    useOnboardingKeyboardScroll: () => ({
      scrollProps: {},
      focusInput: () => {},
      blurInput: () => {},
    }),
  },
});

componentTest(
  "profile: an email session's name follows the rule, and every Continue sends it",
  async () => {
    const render = () => profileHooks.render(() => profileModule.default());
    const nameField = (tree: Node[]) =>
      tree.find((n) => n.type === "FormField" && n.props.label === "onboarding.name.label")!;
    const lastField = (tree: Node[]) =>
      tree.find((n) => n.type === "FormField" && n.props.label === "onboarding.lastName.label")!;
    const phoneInput = (tree: Node[]) => tree.find((n) => n.type === "TextInput")!;
    async function mount(): Promise<Node[]> {
      profileHooks.reset();
      render();
      await settle();
      await settle();
      return render();
    }
    async function next(): Promise<Node[]> {
      const button = render().find(
        (n) => n.type === "Button" && n.props.label === "onboardingProfile.continue",
      );
      assert.ok(button, "Continue");
      await button.props.onPress();
      await settle();
      return render();
    }
    profileSessionKind = "email";
    profileMeta = new Map();
    profileRoutes = [];
    nameSyncs = [];
    let tree = await mount();
    nameField(tree).props.onChangeText("A");
    phoneInput(render()).props.onChangeText("700000001");
    tree = await next();
    assert.equal(
      nameField(tree).props.error,
      "auth.error.name.invalid",
      "one letter is not a name",
    );
    assert.deepEqual(nameSyncs, [], "nothing sent");
    assert.deepEqual(profileRoutes, []);
    nameField(tree).props.onChangeText("  Ahmad  ");
    lastField(render()).props.onChangeText(" Karimi ");
    await next();
    assert.deepEqual(nameSyncs, [["Ahmad Karimi", { force: true }]]);
    assert.deepEqual(profileRoutes, ["/onboarding/kaata"]);
    // Back from the kaata step: the screen comes back with what was typed. The
    // name is fixed, and the CURRENT one is what reaches the server.
    tree = await mount();
    assert.equal(nameField(tree).props.value, "Ahmad");
    nameField(tree).props.onChangeText("Ahmad   Jan");
    await next();
    assert.deepEqual(nameSyncs.at(-1), ["Ahmad Jan Karimi", { force: true }]);
    assert.equal(profileMeta.get("onboarding_self_name"), "Ahmad Jan Karimi");
    // Google or Apple: their own local rule, and only an owed name is ever sent.
    profileSessionKind = "provider";
    nameSyncs = [];
    tree = await mount();
    nameField(tree).props.onChangeText("A");
    await next();
    assert.deepEqual(nameSyncs, [["A Jan Karimi", {}]]);
    // An EMAIL session on a Google account (it added a password): the
    // account's name is Google's, so the same local rule and nothing forced.
    profileSessionKind = "email";
    profileProviders = ["google", "email"];
    nameSyncs = [];
    tree = await mount();
    nameField(tree).props.onChangeText("B");
    tree = await next();
    assert.equal(nameField(tree).props.error, null, "no name error");
    assert.deepEqual(nameSyncs, [["B Jan Karimi", {}]]);
    profileProviders = ["email"];
  },
);

// --- Account settings (app/account.tsx) ------------------------------------------------

const accountHooks = hookStore();
// What GET /v1/account/me answers (null: unreachable), the session, the name state.
let accountMe: Record<string, unknown> | null = null;
let accountSession: "provider" | "email" | null = "email";
let accountNameStateNow: "settled" | "owed" | "invalid" = "settled";
let accountCalls: string[] = [];
let accountToasts: Array<[string, unknown]> = [];
let accountRoutes: unknown[] = [];
let saveNameAnswer: unknown = null;
let accountBinding: import("../auth").SessionSnapshot = {
  bindingVersion: 0,
  accountId: "account-a",
  jwt: "jwt.a",
};
let accountWriteHook: (() => void) | null = null;
let accountReadHook: (() => Promise<Record<string, unknown>>) | null = null;
let accountFocus: (() => void) | null = null;
let accountGuardCompletionHook: (() => void) | null = null;
let accountSuccessBindings: import("../auth").SessionSnapshot[] = [];
let savedNameBinding: import("../auth").SessionSnapshot | undefined;
const accountModule = load<{ default: () => unknown }>("../../app/account", {
  "react/jsx-runtime": jsxRuntime,
  react: accountHooks.react,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-router": {
    useRouter: () => ({
      back: () => accountRoutes.push("back"),
      push: (r: unknown) => accountRoutes.push(r),
      replace: (r: unknown) => accountRoutes.push(r),
    }),
    useFocusEffect: (effect: () => void) => {
      accountFocus = effect;
      accountHooks.react.useEffect(effect, [effect]);
    },
  },
  "react-native": {
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Linking: { openURL: async () => {} },
    Platform: { OS: "android" },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: (x: unknown) => x, hairlineWidth: 1 },
    Text: "Text",
    TextInput: "TextInput",
    View: "View",
  },
  "react-native-safe-area-context": {
    SafeAreaView: "Safe",
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  },
  // The REAL rules, worded by key.
  "../lib/account-rules": keyRules,
  "../lib/auth": {
    SessionChangedError: auth.SessionChangedError,
    captureCurrentSession: async () => ({ ...accountBinding }),
    applyForCurrentSession: async (
      before: import("../auth").SessionSnapshot,
      work: () => Promise<unknown>,
    ) => {
      if (JSON.stringify(before) !== JSON.stringify(accountBinding))
        throw new auth.SessionChangedError();
      const value = await work();
      accountGuardCompletionHook?.();
      return value;
    },
    accountNameState: async () => accountNameStateNow,
    currentSessionKind: async () => accountSession,
    deleteAccount: async () => {},
    fetchAccountMe: async () => {
      if (accountReadHook) return accountReadHook();
      if (!accountMe) throw new auth.SignInFailedError("network", "offline");
      return accountMe;
    },
    getSessionJWT: async () => "jwt",
    hasPendingAccountDeletion: async () => false,
    removePassword: async () => {},
    resetRetiredInstall: async () => {},
    saveAccountDisplayName: async (name: string, before?: import("../auth").SessionSnapshot) => {
      savedNameBinding = before;
      if (before && JSON.stringify(before) !== JSON.stringify(accountBinding))
        return new auth.EmailAuthError("session_expired", 401);
      accountCalls.push(`saveAccountDisplayName:${name}`);
      return saveNameAnswer;
    },
    updateAccountPhone: async (phone: string | null) => {
      accountCalls.push(`updateAccountPhone:${phone}`);
    },
  },
  "../components/Button": { Button: "Button" },
  "../components/ConfirmDialog": { ConfirmDialog: "Dialog" },
  "../components/CountryPickerSheet": { CountryPickerSheet: "CountryPicker" },
  "../components/OptionSheet": { OptionSheet: "OptionSheet" },
  "../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
  "../components/SettingsScreen": {
    NavRow: "NavRow",
    ScreenHeader: "ScreenHeader",
    SectionGap: "SectionGap",
    SectionHeader: "SectionHeader",
  },
  "../components/Toast": {
    useToast: () => ({
      push: (m: string, kind: unknown) => {
        accountToasts.push([m, kind]);
        if (kind === "success") accountSuccessBindings.push({ ...accountBinding });
      },
    }),
  },
  "../lib/colors": { colors: {} },
  "../lib/contacts-sync": {
    joinName: (first: string, last: string | null) => `${first} ${last ?? ""}`.trim(),
    splitName: (name: string) => {
      const space = name.indexOf(" ");
      return space < 0
        ? { firstName: name, lastName: null }
        : { firstName: name.slice(0, space), lastName: name.slice(space + 1) };
    },
  },
  "../lib/db": {
    getAppMeta: async () => null,
    getLocalSelf: async () => ({ name: "Ahmad Karimi", phone: "+93700000001" }),
    setAppMeta: async () => {},
    updateSelfProfile: async (name: string, _shop: unknown, phone: string | null) => {
      accountCalls.push(`updateSelfProfile:${name}:${phone}`);
      accountWriteHook?.();
    },
  },
  "../lib/direction": {
    ltrIsolate: (value: string) => value,
    rowDir: () => ({}),
    textDir: () => ({}),
    useIsRTL: () => false,
  },
  "../lib/event-log": {
    EventSigningUnavailableError: class extends Error {},
    RoleGateRejectionError: class extends Error {},
  },
  "../lib/fonts": { fonts: {} },
  "../lib/i18n": {
    getLocale: () => "en",
    getShareLangPref: async () => "auto",
    setLocale: () => {},
    t: keyT,
  },
  "../lib/calendar": {
    CALENDAR_PREF_KEY: "calendar_pref",
    parseCalendarPref: () => "auto",
    setCalendarPref: () => {},
  },
  "../lib/install-id": { isInstallRetired: async () => false },
  "../lib/jalali": { formatCalendarDate: () => "date" },
  "../lib/phone": {
    getCountry: () => ({ code: "AF", flag: "AF", dialCode: "+93", name: "Afghanistan" }),
    getCurrentDefaultCountryCode: () => "AF",
    inferCountryFromE164: () => "AF",
    normalizePhone: (raw: string) => `+93${raw.replace(/^0/, "")}`,
    setCurrentDefaultCountryCode: () => {},
  },
  "../lib/tokens": {
    gutter: { settings: 20 },
    icon: { row: 22, trailing: 16 },
    radius: {},
    ROW_MIN: 52,
    TOUCH_MIN: 44,
    typography: {},
  },
});

const renderAccount = () => accountHooks.render(() => accountModule.default());

async function openAccount(over: {
  me?: Record<string, unknown> | null;
  session?: "provider" | "email" | null;
  nameState?: "settled" | "owed" | "invalid";
}): Promise<Node[]> {
  accountHooks.reset();
  accountMe = over.me === undefined ? null : over.me;
  accountSession = over.session ?? "email";
  accountNameStateNow = over.nameState ?? "settled";
  accountCalls = [];
  accountToasts = [];
  accountRoutes = [];
  saveNameAnswer = null;
  accountBinding = { bindingVersion: 0, accountId: "account-a", jwt: "jwt.a" };
  accountWriteHook = null;
  accountReadHook = null;
  accountGuardCompletionHook = null;
  accountSuccessBindings = [];
  savedNameBinding = undefined;
  renderAccount();
  for (let i = 0; i < 6; i++) {
    await settle();
    renderAccount();
  }
  return renderAccount();
}

const accountInput = (tree: Node[], label: string) => {
  const input = tree.find((n) => n.type === "TextInput" && n.props.accessibilityLabel === label);
  assert.ok(input, `no input ${label}`);
  return input;
};

async function saveAccount(): Promise<Node[]> {
  const button = renderAccount().find(
    (n) => n.type === "Button" && n.props.label === "account.save",
  );
  assert.ok(button, "Save");
  await button.props.onPress();
  await settle();
  return renderAccount();
}

const nameErrorShown = (tree: Node[]) => texts(tree).includes("auth.error.name.invalid");

const accountMeOf = (providers: string[]) => ({
  email: "a@gmail.com",
  loginEmail: "a@gmail.com",
  username: null,
  hasPassword: true,
  providers,
  name: "Ahmad Karimi",
  setupEmail: null,
});

componentTest("account: an email session on a Google account saves a phone change", async () => {
  let tree = await openAccount({ me: accountMeOf(["google", "email"]), session: "email" });
  accountInput(tree, "personEdit.phone.label").props.onChangeText("700000002");
  tree = await saveAccount();
  assert.equal(nameErrorShown(tree), false, "no name error");
  assert.deepEqual(accountCalls, [
    "updateSelfProfile:Ahmad Karimi:+93700000002",
    "updateAccountPhone:+93700000002",
  ]);
  assert.deepEqual(accountToasts, [["settings.saved", "success"]]);
  assert.deepEqual(accountRoutes, ["back"], "and back");
  // The Kaata name can change independently of the linked Google identity.
  tree = await openAccount({ me: accountMeOf(["google", "email"]), session: "email" });
  accountInput(tree, "personEdit.firstName.label").props.onChangeText("A");
  tree = await saveAccount();
  assert.equal(nameErrorShown(tree), false);
  assert.ok(accountCalls.includes("saveAccountDisplayName:A Karimi"), "explicit provider rename");
  assert.deepEqual(accountRoutes, ["back"]);
});

componentTest(
  "account: an email account's name follows the rule and is sent when it changed",
  async () => {
    // Unchanged: nothing is sent.
    let tree = await openAccount({ me: accountMeOf(["email"]) });
    accountInput(tree, "personEdit.phone.label").props.onChangeText("700000003");
    await saveAccount();
    assert.ok(!accountCalls.some((c) => c.includes("DisplayName")), "the name did not change");
    // Too short: the rule, nothing saved.
    tree = await openAccount({ me: accountMeOf(["email"]) });
    accountInput(tree, "personEdit.firstName.label").props.onChangeText("A");
    accountInput(renderAccount(), "personEdit.lastName.label").props.onChangeText("");
    tree = await saveAccount();
    assert.ok(nameErrorShown(tree));
    assert.equal(accountCalls.length, 0, "nothing saved");
    // Changed and valid, refused by the server: the refusal instead of "Saved".
    tree = await openAccount({ me: accountMeOf(["email"]) });
    accountInput(tree, "personEdit.firstName.label").props.onChangeText("Mahmood");
    saveNameAnswer = new auth.EmailAuthError("invalid_name", 400);
    tree = await saveAccount();
    assert.ok(accountCalls.includes("saveAccountDisplayName:Mahmood Karimi"));
    assert.ok(nameErrorShown(tree));
    assert.equal(accountToasts.length, 0, 'no "Saved"');
    assert.equal(accountRoutes.length, 0, "stays");
    // Account unknown (offline): the email session decides.
    const warn = console.warn;
    console.warn = () => {};
    try {
      tree = await openAccount({ me: null, session: "email" });
    } finally {
      console.warn = warn;
    }
    accountInput(tree, "personEdit.firstName.label").props.onChangeText("Z");
    accountInput(renderAccount(), "personEdit.lastName.label").props.onChangeText("");
    tree = await saveAccount();
    assert.ok(nameErrorShown(tree));
  },
);

componentTest("account: opens with the name error when the phone's name was unusable", async () => {
  let tree = await openAccount({ me: accountMeOf(["email"]), nameState: "invalid" });
  assert.ok(nameErrorShown(tree), "shown on open");
  accountInput(tree, "personEdit.firstName.label").props.onChangeText("Mo");
  tree = renderAccount();
  assert.equal(nameErrorShown(tree), false, "typing clears it");
  await saveAccount();
  assert.ok(accountCalls.includes("saveAccountDisplayName:Mo Karimi"), "the fix is sent");
  assert.deepEqual(accountRoutes, ["back"]);
  // Still owed and unchanged: sent anyway, to settle it.
  tree = await openAccount({ me: accountMeOf(["email"]), nameState: "owed" });
  await saveAccount();
  assert.ok(accountCalls.includes("saveAccountDisplayName:Ahmad Karimi"));
});

componentTest(
  "account: fresh cloud names prefill, provider rename rules apply, unchanged long names permit phone edits",
  async () => {
    let tree = await openAccount({
      me: { ...accountMeOf(["google"]), name: "Current Cloud Name" },
      session: "provider",
    });
    assert.equal(accountInput(tree, "personEdit.firstName.label").props.value, "Current");
    assert.equal(accountInput(tree, "personEdit.lastName.label").props.value, "Cloud Name");
    accountInput(tree, "personEdit.firstName.label").props.onChangeText("A");
    accountInput(renderAccount(), "personEdit.lastName.label").props.onChangeText("");
    tree = await saveAccount();
    assert.ok(nameErrorShown(tree));
    assert.equal(accountCalls.length, 0, "invalid provider rename never writes locally");
    const longName = "Provider " + "Surname".repeat(9);
    tree = await openAccount({
      me: { ...accountMeOf(["google"]), name: longName },
      session: "provider",
    });
    accountInput(tree, "personEdit.phone.label").props.onChangeText("700000004");
    await saveAccount();
    assert.ok(!accountCalls.some((call) => call.startsWith("saveAccountDisplayName")));
    assert.deepEqual(accountToasts, [["settings.saved", "success"]]);
    tree = await openAccount({
      me: { ...accountMeOf(["google"]), name: "Old Cloud" },
      session: "provider",
      nameState: "owed",
    });
    assert.equal(
      accountInput(tree, "personEdit.firstName.label").props.value,
      "Ahmad",
      "queued local edit survives fresh cloud read",
    );
  },
);

componentTest(
  "account: save retains its starting account and late cloud reads cannot repaint a different session",
  async () => {
    let tree = await openAccount({ me: accountMeOf(["google"]), session: "provider" });
    const intended = { ...accountBinding };
    accountInput(tree, "personEdit.firstName.label").props.onChangeText("Chosen");
    accountWriteHook = () => {
      accountBinding = { bindingVersion: 1, accountId: "account-b", jwt: "jwt.b" };
    };
    await saveAccount();
    assert.deepEqual(savedNameBinding, intended, "capture precedes the async local save");
    assert.equal(accountToasts.length, 0, "a session change does not claim Saved");
    assert.equal(accountRoutes.length, 0);

    tree = await openAccount({ me: accountMeOf(["google"]), session: "provider" });
    const starting = { ...accountBinding };
    let guardCompletions = 0;
    accountGuardCompletionHook = () => {
      if (++guardCompletions === 2)
        accountBinding = { bindingVersion: 1, accountId: "account-b", jwt: "jwt.b" };
    };
    accountInput(tree, "personEdit.phone.label").props.onChangeText("700000008");
    await saveAccount();
    assert.deepEqual(
      accountSuccessBindings,
      [starting],
      "success executes while the starting session is guarded",
    );

    tree = await openAccount({ me: accountMeOf(["google"]), session: "provider" });
    accountInput(tree, "personEdit.phone.label").props.onChangeText("700000009");
    accountWriteHook = () => {
      accountBinding = { bindingVersion: 1, accountId: "account-b", jwt: "jwt.b" };
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await saveAccount();
    } finally {
      console.warn = warn;
    }
    assert.equal(accountToasts.length, 0, "phone-only save also checks before claiming Saved");
    assert.equal(accountRoutes.length, 0);

    // Re-focus begins a fresh server read, and an account switch happens while
    // that read waits. The old name must never be applied to the current form.
    await openAccount({ me: accountMeOf(["google"]), session: "provider" });
    let resolve!: (account: Record<string, unknown>) => void;
    accountReadHook = () =>
      new Promise((done) => {
        resolve = done;
      });
    accountFocus!();
    await settle();
    accountBinding = { bindingVersion: 2, accountId: "account-b", jwt: "jwt.b" };
    resolve({ ...accountMeOf(["google"]), name: "Wrong Account Name" });
    await settle();
    tree = renderAccount();
    assert.equal(
      accountInput(tree, "personEdit.firstName.label").props.value,
      "Ahmad",
      "late read cannot overwrite the current form",
    );
    accountReadHook = null;
  },
);

// --- the sign-in screen (app/onboarding/auth.tsx) ------------------------------------

const screenHooks = hookStore();
let backHandlers: Array<() => boolean> = [];
let screenPending: unknown = null;
let screenRoutes: unknown[] = [];
let platform = "android";
const screen = load<{
  AuthScreen: (props: {
    redirected?: boolean;
    initialMode?: "providers" | "email";
    emailRoute?: boolean;
    providerReady?: boolean;
  }) => unknown;
}>("../../app/onboarding/auth", {
  "react/jsx-runtime": jsxRuntime,
  react: screenHooks.react,
  "react-native": {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ActivityIndicator: "Spinner",
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        backHandlers.push(handler);
        return { remove: () => (backHandlers = backHandlers.filter((h) => h !== handler)) };
      },
    },
    Keyboard: { dismiss: () => {} },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    ScrollView: "ScrollView",
    get Platform() {
      return { OS: platform, select: (x: Record<string, unknown>) => x[platform] };
    },
    StyleSheet: { create: (x: unknown) => x, hairlineWidth: 1 },
  },
  "react-native-safe-area-context": { SafeAreaView: "Safe" },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-constants": { __esModule: true, default: { executionEnvironment: "standalone" } },
  "expo-router": {
    Stack: { Screen: "StackScreen" },
    useIsFocused: () => true,
    useFocusEffect: (effect: () => void) => screenHooks.react.useEffect(effect, [effect]),
    useRouter: () => ({
      push: (r: unknown) => screenRoutes.push({ push: r }),
      replace: (r: unknown) => screenRoutes.push(r),
      dismissTo: (r: unknown) => screenRoutes.push({ dismissTo: r }),
      back: () => screenRoutes.push("back"),
      canGoBack: () => true,
    }),
  },
  "../../components/EmailAuthFlow": { EmailAuthFlow: "EmailAuthFlow" },
  "../../lib/use-onboarding-keyboard-scroll": {
    useOnboardingKeyboardScroll: () => ({
      scrollProps: {},
      focusInput: () => {},
      blurInput: () => {},
    }),
  },
  "../../components/GoogleGIcon": { GoogleGIcon: "Google" },
  "../../components/NinjaIcon": { NinjaIcon: "Ninja" },
  "../../components/ConfirmDialog": { ConfirmDialog: "Dialog" },
  "../../lib/recovery": { recoverAllVaults: async () => ({ recovered: [], failed: [] }) },
  "../../lib/sync/reconcile": { reconcileVaultRegistrations: async () => {} },
  "../../lib/auth": {
    isGoogleSignInAvailable: () => true,
    isCancellation: auth.isCancellation,
    SignInFailedError: auth.SignInFailedError,
    InstallRetiredError: auth.InstallRetiredError,
    readEmailFlowPending: async () => screenPending,
    // The server asks "different account?"; the screen's dialog answers.
    signInWithGoogle: async (prompt: (args: PromptArgs) => Promise<string>) => {
      const choice = await prompt({ cachedEmail: "old@example.com", newEmail: "new@example.com" });
      if (choice === "cancel") throw new auth.SignInCancelledByUserError();
      return { email: "new@example.com" };
    },
    signInWithApple: async () => ({}),
    resetRetiredInstall: async () => {},
  },
  "../../lib/crash-report": { queueCrashReport: async () => {} },
  "../../lib/colors": { colors: {} },
  "../../lib/db": {
    getAppMeta: async () => null,
    setAppMeta: async () => {},
    getLocalSelf: async () => null,
  },
  "../../lib/db-tx": { getActiveVaultIdSyncMaybe: () => null, setActiveVaultId: async () => {} },
  "../../lib/currency": { applyVaultCurrency: async () => {} },
  "../../lib/direction": {
    ltrIsolate: (value: string) => `<${value}>`,
    rowDir: () => ({}),
    textDir: () => ({}),
    trackingSafe: () => ({}),
    useIsRTL: () => false,
  },
  "../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, tight: number) => tight },
  "../../lib/i18n": { t: keyT },
  "../../lib/tokens": { icon: {}, radius: {}, TOUCH_MIN: 44, typography: {} },
});

let screenProps: {
  redirected?: boolean;
  initialMode?: "providers" | "email";
  emailRoute?: boolean;
  providerReady?: boolean;
} = {};
const renderScreen = () => screenHooks.render(() => screen.AuthScreen(screenProps));

function mountScreen(props: typeof screenProps = {}, pending: unknown = null): Node[] {
  screenHooks.reset();
  backHandlers = [];
  screenRoutes = [];
  screenPending = pending;
  screenProps = props;
  return renderScreen();
}

const flowIn = (tree: Node[]) => tree.find((n) => n.type === "EmailAuthFlow");
const mountEmailScreen = async (props: typeof screenProps = {}, pending: unknown = null) => {
  mountScreen({ ...props, emailRoute: true }, pending);
  await settle();
  return renderScreen();
};

componentTest("screen: Continue with email under the two cards, on both platforms", async () => {
  for (const os of ["android", "ios"]) {
    platform = os;
    let tree = mountScreen();
    const pressables = tree
      .filter((n) => n.type === "Pressable")
      .map((n) => n.props.accessibilityLabel);
    const email = pressables.indexOf("onboardingMode.email.title");
    assert.ok(email >= 0, `${os}: offered`);
    assert.ok(email > pressables.indexOf("onboardingMode.google.title"), `${os}: under Google`);
    assert.ok(email > pressables.indexOf("onboardingMode.apple.title"), `${os}: under Apple`);
    await control(tree, "onboardingMode.email.title")?.props.onPress();
    assert.deepEqual(
      screenRoutes,
      [{ push: { pathname: "/auth/email", params: { redirected: "0" } } }],
      "the provider choices stay beneath a native email screen",
    );
    tree = await mountEmailScreen();
    tree = renderScreen();
    const flow = flowIn(tree);
    assert.ok(flow, `${os}: the email flow`);
    assert.equal(flow.props.entry, "signup", "onboarding opens on sign-up");
    const scroll = tree.find((n) => n.type === "ScrollView");
    assert.ok(
      nodes(scroll?.props.children).some((n) => n.type === "EmailAuthFlow"),
      "inside the ScrollView",
    );
    assert.equal(control(tree, "onboardingMode.google.title"), undefined, "the cards make way");
  }
  platform = "android";
  // Legacy /sign-in?mode=email preserves the selector before opening the form.
  mountScreen({ redirected: true, initialMode: "email" });
  assert.deepEqual(screenRoutes, [
    { push: { pathname: "/auth/email", params: { redirected: "1" } } },
  ]);
  const tree = await mountEmailScreen({ redirected: true });
  assert.equal(flowIn(tree)?.props.entry, "signin");
  assert.equal(tree.find((n) => n.type === "StackScreen")?.props.options.gestureEnabled, true);
});

componentTest("screen: Back, hardware or on-screen, walks the flow, then out of it", async () => {
  let tree = await mountEmailScreen({ redirected: true });
  let steps = 1;
  flowIn(tree)!.props.backRef.current = () => steps-- > 0;
  flowIn(tree)!.props.onCanStepBackChange(true);
  tree = renderScreen();
  assert.equal(
    tree.find((n) => n.type === "StackScreen")?.props.options.gestureEnabled,
    false,
    "a native swipe cannot bypass code cancellation or the form's intermediate steps",
  );
  assert.equal(backHandlers.length, 1, "hardware back is taken in email mode");
  assert.equal(backHandlers[0](), true);
  flowIn(tree)!.props.onCanStepBackChange(false);
  tree = renderScreen();
  assert.ok(flowIn(tree), "one step back inside the flow");
  assert.equal(
    tree.find((n) => n.type === "StackScreen")?.props.options.gestureEnabled,
    true,
    "the first form can swipe back to its selector again",
  );
  await control(tree, "common.back")?.props.onPress();
  assert.deepEqual(screenRoutes, [{ dismissTo: "/sign-in" }], "return to the selector route");
  tree = mountScreen({ redirected: true });
  assert.equal(flowIn(tree), undefined, "the selector shows its cards");
  assert.ok(control(tree, "onboardingMode.google.title"));
  assert.equal(backHandlers.length, 0, "and Back belongs to the router again");
  assert.deepEqual(screenRoutes, []);
});

componentTest(
  "screen: a pending sign-up or reset code reopens the flow; a setup code does not",
  async () => {
    const pending = { purpose: "signup", email: "a@example.com", sentAt: Date.now() };
    mountScreen({}, pending);
    await settle();
    assert.deepEqual(
      screenRoutes,
      [{ push: { pathname: "/auth/email", params: { redirected: "0" } } }],
      "cold resume keeps the selector beneath the code form",
    );
    let loading = mountScreen({ emailRoute: true }, pending);
    assert.equal(flowIn(loading), undefined, "read the pending step before mounting fresh fields");
    assert.equal(
      loading.find((n) => n.type === "StackScreen")?.props.options.gestureEnabled,
      false,
      "a cold code resume never permits a first-frame native pop",
    );
    await settle();
    let tree = renderScreen();
    assert.deepEqual(flowIn(tree)?.props.resume, pending);
    mountScreen({}, { purpose: "setup", email: "a@example.com", sentAt: Date.now() });
    await settle();
    tree = renderScreen();
    assert.equal(flowIn(tree), undefined, "Account settings' code is not this screen's");
  },
);

componentTest("screen: the flow runs through the screen's gate and outcome", async () => {
  let tree = await mountEmailScreen();
  let flow = flowIn(tree)!;
  let release!: () => void;
  const running = flow.props.run(() => new Promise<void>((done) => (release = done)));
  tree = renderScreen();
  assert.equal(flowIn(tree)?.props.busy, true, "one sign-in at a time");
  assert.equal(
    tree.find((n) => n.type === "StackScreen")?.props.options.gestureEnabled,
    false,
    "native swipe cannot leave during authentication",
  );
  release();
  await running;
  tree = renderScreen();
  flow = flowIn(tree)!;
  assert.equal(flow.props.busy, false);
  // A failure the flow cannot word is the screen's coded copy, on the form
  // (and reported, as every sign-in failure is; quiet here).
  const warn = console.warn;
  console.warn = () => {};
  try {
    flow.props.onFailure(new auth.SignInFailedError("server", "down", "503"));
  } finally {
    console.warn = warn;
  }
  tree = renderScreen();
  const notice = nodes(flowIn(tree)?.props.notice);
  assert.ok(notice.some((n) => textOf(n) === "onboardingMode.signInFailed (server 503)"));
  // A retired install offers its reset there too.
  flowIn(tree)?.props.onFailure(new auth.InstallRetiredError());
  tree = renderScreen();
  assert.ok(
    nodes(flowIn(tree)?.props.notice).some(
      (n) => n.props.accessibilityLabel === "account.retired.reset",
    ),
  );
  // Success goes where every sign-in goes.
  await flowIn(tree)?.props.onSignedIn({ email: "a@example.com" });
  assert.deepEqual(
    screenRoutes,
    [{ dismissTo: "/onboarding/auth" }, "/onboarding/restore"],
    "success replaces the provider selector too, preserving the original history",
  );
});

componentTest("screen: the different-account question names both accounts, isolated", async () => {
  let tree = mountScreen({}, null);
  const signingIn = control(tree, "onboardingMode.google.title")?.props.onPress();
  await settle();
  tree = renderScreen();
  const dialog = tree.find(
    (n) => n.type === "Dialog" && n.props.title === "account.differentAccount.title",
  );
  assert.equal(dialog?.props.visible, true);
  assert.equal(
    dialog?.props.description,
    `account.differentAccount.body {"oldEmail":"<old@example.com>","newEmail":"<new@example.com>"}`,
  );
  dialog?.props.onCancel();
  await signingIn;
  tree = renderScreen();
  assert.equal(screenRoutes.length, 0, "cancelled: nowhere");
  await control(tree, "onboardingMode.email.title")?.props.onPress();
  tree = await mountEmailScreen();
  assert.equal(
    typeof flowIn(tree)?.props.promptDifferentAccount,
    "function",
    "email asks the same",
  );
});

// --- the check-in heartbeat (lib/app-meta-context.tsx) --------------------------------

test("check-in: the binding's heartbeat keys on account_id, and retries a name owed", async () => {
  const meta = new Map<string, string>();
  let nameSyncs = 0;
  const contextModule = load<{
    AppMetaProvider: (props: { currentVersion: string; children: unknown }) => Node;
  }>("../app-meta-context", {
    "react/jsx-runtime": jsxRuntime,
    react: {
      createContext: () => ({ Provider: "Provider" }),
      useCallback: (fn: unknown) => fn,
      useContext: () => null,
      useEffect: () => {},
      useState: (initial: unknown) => [initial, () => {}],
    },
    "./auth": {
      rotateSessionJWT: async () => {},
      syncPendingAccountNameFromSelf: async () => {
        nameSyncs++;
      },
    },
    "./db": {
      getAppMeta: async (key: string) => meta.get(key) ?? null,
      setAppMeta: async (key: string, value: string) => {
        meta.set(key, value);
      },
    },
  });
  const checkIn = () =>
    contextModule
      .AppMetaProvider({ currentVersion: "2.1.0", children: null })
      .props.value.applyCheckIn({ update: null, announcement: null, force_update: false });
  // An email-only binding: no provider subject, still a binding to protect.
  meta.set("account_id", "acct-email");
  meta.set("account_google_sub", "");
  const before = Date.now();
  await checkIn();
  assert.ok(Number(meta.get("account_last_seen_at")) >= before, "refreshed for an email account");
  assert.equal(nameSyncs, 1, "a name still owed is retried at check-in");
  // No binding at all: nothing to keep alive, whatever a stale sub says.
  meta.clear();
  meta.set("account_google_sub", "stale-sub");
  await checkIn();
  assert.equal(meta.get("account_last_seen_at"), undefined);
});

async function main() {
  // Fail closed: a case stuck on a promise that never settles empties the event
  // loop, and Node would exit with whatever code is set at that moment.
  process.exitCode = 1;
  let finished = false;
  process.on("exit", () => {
    if (!finished) console.error("email-auth: a case never finished; treating as failure");
  });
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}\n`, err);
    }
  }
  finished = true;
  console.log(`${cases.length - failed} email-auth regressions passed; ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
