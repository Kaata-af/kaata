// Execute the real snapshot fetch with controlled headers/body and deadline.
// No network, account credentials, or persistent database is involved.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

function fixture(status = 200) {
  const headers = deferred<void>();
  const body = deferred<unknown>();
  let deadline: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  let clearCount = 0;
  let bodyReads = 0;
  const restore = compileUI(
    "../restore",
    {
      "./credit-policy-cache": {},
      "./api": { getBackendUrl: async () => "https://snapshot.invalid" },
      "./auth": { getSessionJWT: async () => "synthetic-session" },
      "./db-tx": {},
      "./hlc": {},
      "./projection/field-hlc": {},
      "./customer-group-restore": {},
      "./projection/ingest-row": {},
      "./projection/sweep": {},
      "./sync/cursor": {},
    },
    {
      setTimeout: (callback: () => void, ms: number) => {
        assert.equal(ms, 30_000);
        deadline = callback;
        return 1;
      },
      clearTimeout: (id: number) => {
        assert.equal(id, 1);
        clearCount++;
        deadline = null;
      },
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(url, "https://snapshot.invalid/v1/sync/snapshot?vault_id=joined-kaata");
        assert.equal(
          (init.headers as Record<string, string>).Authorization,
          "Bearer synthetic-session",
        );
        signal = init.signal!;
        await headers.promise;
        return {
          status,
          ok: status >= 200 && status < 300,
          json: () => {
            bodyReads++;
            return body.promise;
          },
        };
      },
    },
  );
  return {
    restore,
    headers,
    body,
    get signal() {
      return signal;
    },
    get clearCount() {
      return clearCount;
    },
    get bodyReads() {
      return bodyReads;
    },
    fireDeadline() {
      assert.ok(deadline, "deadline must remain active through body consumption");
      deadline();
    },
    run: () => restore.fetchSnapshot({ defaultVaultId: "joined-kaata" }),
  };
}

async function run() {
  // A stalled body after successful headers must be bounded even when the
  // mocked body reader never observes AbortSignal (native implementations can
  // deliver cancellation late). This is the invite pre-witness stall regression.
  const stalledBody = fixture();
  const pendingBody = stalledBody.run();
  stalledBody.headers.resolve();
  await settleUI();
  assert.equal(stalledBody.bodyReads, 1);
  assert.equal(stalledBody.clearCount, 0, "headers alone must not clear timeout");
  const bodyRejected = assert.rejects(pendingBody, stalledBody.restore.RestoreTimeoutError);
  stalledBody.fireDeadline();
  await bodyRejected;
  assert.equal(stalledBody.signal?.aborted, true);
  assert.equal(stalledBody.clearCount, 1);
  stalledBody.body.resolve({ late: true });
  await settleUI();

  // The same deadline also bounds a fetch which never returns headers.
  const stalledHeaders = fixture();
  const pendingHeaders = stalledHeaders.run();
  await settleUI();
  const headersRejected = assert.rejects(
    pendingHeaders,
    stalledHeaders.restore.RestoreTimeoutError,
  );
  stalledHeaders.fireDeadline();
  await headersRejected;
  assert.equal(stalledHeaders.signal?.aborted, true);
  assert.equal(stalledHeaders.bodyReads, 0);

  const successful = fixture();
  const completed = successful.run();
  successful.headers.resolve();
  await settleUI();
  assert.equal(successful.clearCount, 0);
  const snapshot = { vault: { id: "joined-kaata" }, events: [] };
  successful.body.resolve(snapshot);
  assert.equal(await completed, snapshot);
  assert.equal(successful.clearCount, 1);
  assert.equal(successful.signal?.aborted, false);

  const absent = fixture(404);
  const missing = absent.run();
  absent.headers.resolve();
  assert.equal(await missing, null);
  assert.equal(absent.bodyReads, 0);
  assert.equal(absent.clearCount, 1);

  const expired = fixture(401);
  const unauthorized = expired.run();
  expired.headers.resolve();
  await assert.rejects(unauthorized, expired.restore.RestoreSessionExpiredError);
  assert.equal(expired.bodyReads, 0);
  assert.equal(expired.clearCount, 1);

  const malformed = fixture();
  const invalid = malformed.run();
  malformed.headers.resolve();
  await settleUI();
  const syntaxError = new SyntaxError("truncated snapshot");
  const invalidRejected = assert.rejects(invalid, (error) => error === syntaxError);
  malformed.body.reject(syntaxError);
  await invalidRejected;
  assert.equal(malformed.clearCount, 1);
  assert.equal(malformed.signal?.aborted, false);

  console.log(
    "snapshot-timeout: 6 cases passed (headers, body, success, absent, session, malformed)",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
