import assert from "node:assert/strict";
import {
  completeAccountDeletion,
  requestAccountDeletion,
  resumeConfirmedDeletion,
} from "../account-deletion";

async function main() {
  let requests = 0;
  let resets = 0;
  const attempt = async (jwt: string | null, status: number, body: string) => {
    await requestAccountDeletion(jwt, "https://example.test", (async (_url, init) => {
      requests++;
      assert.equal(init?.method, "DELETE");
      return new Response(body, { status });
    }) as typeof fetch);
    resets++;
  };
  await assert.rejects(attempt(null, 200, '{"status":"deleted"}'), /auth_required/);
  assert.equal(requests, 0);
  for (const status of [401, 403, 500]) {
    await assert.rejects(attempt("expired", status, '{"status":"deleted"}'));
  }
  await assert.rejects(attempt("session", 200, '{"status":"ok"}'), /unconfirmed/);
  await assert.rejects(attempt("session", 200, "invalid json"));
  assert.equal(resets, 0, "unconfirmed deletion must preserve the local ledger");
  await attempt("session", 200, '{"status":"deleted"}');
  assert.equal(resets, 1);

  let confirmation: string | null = null;
  let pendingAttempt: string | null = null;
  let serverCalls = 0;
  let cleanupCalls = 0;
  const recovery = {
    jwt: "deleted-session" as string | null,
    readAttempt: async () => pendingAttempt,
    saveAttempt: async (jwt: string) => {
      pendingAttempt = jwt;
    },
    clearAttempt: async () => {
      pendingAttempt = null;
    },
    readConfirmation: async () => confirmation,
    saveConfirmation: async (jwt: string) => {
      confirmation = jwt;
    },
    clearConfirmation: async () => {
      confirmation = null;
    },
    confirmServer: async () => {
      serverCalls++;
    },
    clearLocalData: async () => {
      cleanupCalls++;
      if (cleanupCalls === 1) throw new Error("device cleanup interrupted");
    },
  };
  await assert.rejects(completeAccountDeletion(recovery), /interrupted/);
  assert.equal(confirmation, "deleted-session", "server confirmation survives failed cleanup");
  recovery.jwt = null; // SecureStore session cleanup may already have succeeded.
  await completeAccountDeletion(recovery);
  assert.equal(serverCalls, 1, "confirmed cleanup retries without a now-revoked session");
  assert.equal(cleanupCalls, 2);
  assert.equal(confirmation, null);
  assert.equal(pendingAttempt, null);

  confirmation = "old-session";
  recovery.jwt = "different-account-session";
  recovery.confirmServer = async () => {
    throw new Error("server refused");
  };
  await assert.rejects(completeAccountDeletion(recovery), /server refused/);
  assert.equal(cleanupCalls, 2, "old receipt cannot authorize erasing a new account");
  confirmation = null;
  recovery.jwt = "session";
  recovery.confirmServer = async () => {};
  recovery.saveConfirmation = async () => {
    throw new Error("keychain unavailable");
  };
  await assert.rejects(completeAccountDeletion(recovery), /keychain unavailable/);
  assert.equal(cleanupCalls, 2, "keep local records if confirmation could not be persisted");

  pendingAttempt = null;
  recovery.jwt = "lost-response-session";
  recovery.confirmServer = async () => {
    throw new Error("response lost");
  };
  recovery.saveConfirmation = async (jwt) => {
    confirmation = jwt;
  };
  await assert.rejects(completeAccountDeletion(recovery), /response lost/);
  assert.equal(pendingAttempt, "lost-response-session");
  recovery.jwt = null; // The sync loop cleared the active session after a 401.
  recovery.confirmServer = async () => {
    throw new Error("still unconfirmed");
  };
  await assert.rejects(completeAccountDeletion(recovery), /still unconfirmed/);
  assert.equal(cleanupCalls, 2, "a saved attempt alone never permits a local wipe");
  recovery.confirmServer = async () => {};
  await completeAccountDeletion(recovery);
  assert.equal(cleanupCalls, 3);
  assert.equal(pendingAttempt, null);

  confirmation = "account-a-confirmed";
  recovery.jwt = "account-b-current";
  recovery.confirmServer = async () => {
    throw new Error("must not call server during boot");
  };
  await resumeConfirmedDeletion(recovery);
  assert.equal(cleanupCalls, 3, "startup must not delete a different account locally or remotely");
  assert.equal(confirmation, null);
  confirmation = "account-a-confirmed";
  recovery.jwt = null;
  pendingAttempt = "account-a-confirmed";
  await resumeConfirmedDeletion(recovery);
  assert.equal(cleanupCalls, 4, "confirmed partial cleanup resumes locally without a session");
  assert.equal(confirmation, null);
  console.log(
    "account-deletion: confirmed success only; missing/expired/error responses preserve local data",
  );
}

void main();
