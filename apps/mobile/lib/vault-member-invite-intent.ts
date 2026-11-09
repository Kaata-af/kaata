import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import { isVaultMemberRequestToken } from "./vault-member-requests";

const ACCEPTANCE_WINDOW_MS = 30_000;
let pending: {
  nonce: string;
  token: string;
  accountId: string;
  bindingVersion: number;
  expiresAt: number;
} | null = null;

/** Only an explicit inbox tap can authorize the shortcut. A route parameter
 * copied into a deep link cannot create this in-memory consent. */
export async function prepareVaultMemberInviteAcceptance(
  token: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  const current = () => AppState.currentState === "active" && isCurrent();
  if (!isVaultMemberRequestToken(token) || !current()) return null;
  try {
    const session = await captureCurrentSession();
    const { accountId, bindingVersion, jwt } = session;
    if (!accountId || !jwt || !current()) return null;
    return await applyForCurrentSession(session, async () => {
      if (!current()) return null;
      const nonce = randomUUID();
      pending = {
        nonce,
        token,
        accountId,
        bindingVersion,
        expiresAt: Date.now() + ACCEPTANCE_WINDOW_MS,
      };
      return nonce;
    });
  } catch (error) {
    if (error instanceof SessionChangedError) return null;
    throw error;
  }
}

export function consumeVaultMemberInviteAcceptance(
  token: string,
  nonce: string,
  session: SessionSnapshot,
): boolean {
  const intent = pending;
  if (!intent || intent.nonce !== nonce) return false;
  pending = null;
  return (
    intent.token === token &&
    intent.accountId === session.accountId &&
    intent.bindingVersion === session.bindingVersion &&
    !!session.jwt &&
    intent.expiresAt > Date.now()
  );
}
