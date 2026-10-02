// Keep the destructive local reset behind an explicit server acknowledgement.
// An expired or revoked session (401) is not evidence of account deletion.
export async function requestAccountDeletion(
  jwt: string | null,
  baseUrl: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!jwt) throw new Error("account_delete_auth_required");
  const res = await request(`${baseUrl}/v1/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (res.status === 401) throw new Error("account_delete_auth_required");
  if (!res.ok) throw new Error(`account_delete_failed:${res.status}`);
  const body: unknown = await res.json();
  if (!body || typeof body !== "object" || !("status" in body) || body.status !== "deleted") {
    throw new Error("account_delete_unconfirmed");
  }
}

type DeletionRecovery = {
  jwt: string | null;
  readConfirmation: () => Promise<string | null>;
  readAttempt: () => Promise<string | null>;
  saveAttempt: (jwt: string) => Promise<void>;
  clearAttempt: () => Promise<void>;
  saveConfirmation: (jwt: string) => Promise<void>;
  clearConfirmation: () => Promise<void>;
  confirmServer: (jwt: string | null) => Promise<void>;
  clearLocalData: () => Promise<void>;
};

// Persist the server acknowledgement before any local cleanup. SecureStore may
// fail halfway through cleanup, and a restart must still be able to finish it.
// The receipt is scoped to the session that was deleted: it cannot authorize
// wiping a different account which has since signed in on this phone.
export async function completeAccountDeletion(recovery: DeletionRecovery): Promise<void> {
  const jwt = recovery.jwt ?? (await recovery.readAttempt());
  const confirmation = await recovery.readConfirmation();
  if (!confirmation || (jwt !== null && confirmation !== jwt)) {
    if (!jwt) throw new Error("account_delete_auth_required");
    // Automatic sign-out can race the DELETE response. Keep this separate
    // from the active session; it only authorizes another server request.
    await recovery.saveAttempt(jwt);
    await recovery.confirmServer(jwt);
    await recovery.saveConfirmation(jwt);
  }
  await recovery.clearLocalData();
  await recovery.clearAttempt();
  await recovery.clearConfirmation();
}

// Boot recovery is LOCAL ONLY. A stale receipt must never trigger a DELETE
// request for whichever different account happens to be signed in now.
export async function resumeConfirmedDeletion(recovery: DeletionRecovery): Promise<void> {
  const confirmation = await recovery.readConfirmation();
  if (!confirmation) return;
  const session = recovery.jwt ?? (await recovery.readAttempt());
  if (session !== null && session !== confirmation) {
    await recovery.clearConfirmation();
    return;
  }
  await recovery.clearLocalData();
  await recovery.clearAttempt();
  await recovery.clearConfirmation();
}
