import * as Crypto from "expo-crypto";
import { getAccountIdSync, getInstallIdSync, getLocalSelfUserIdSync, type SQLiteTx } from "./db-tx";
import { requireEnabledCurrencies } from "./currency-settings";
import { requireCurrencyCode } from "./currency-scope";
import type { LedgerEvent } from "./events";
import { applyLocalEventsAtomically } from "./projection";
import { buildLocalAccountId } from "./trust/account-id";

/** Validate the complete draft before preparing a key or writing any rows. */
export function validateInitialVaultCurrencies(
  currency: string,
  enabledCurrencies?: readonly string[],
): string[] {
  requireCurrencyCode(currency);
  const codes = requireEnabledCurrencies(enabledCurrencies ?? [currency]);
  if (!codes.includes(currency)) throw new Error("The default currency must be enabled");
  return codes;
}

/** Mint data, signed owner genesis and both initial settings become visible
 * together. The initializer owns no transaction; a refusal rolls it all back. */
export async function createVaultWithCurrencies(
  args: {
    vaultId: string;
    currency: string;
    enabledCurrencies?: readonly string[];
    expectedSignerPubkey: string;
    authorUserId?: string;
    accountId?: string | null;
    ownerDisplayName?: string | null;
  },
  initialize: (tx: SQLiteTx) => Promise<void>,
): Promise<void> {
  const codes = validateInitialVaultCurrencies(args.currency, args.enabledCurrencies);
  const author = args.authorUserId ?? getLocalSelfUserIdSync();
  if (!author) throw new Error("A local self is required to create a Kaata");
  if (!args.vaultId || !args.expectedSignerPubkey) throw new Error("Invalid new Kaata identity");
  const accountId = args.accountId === undefined ? getAccountIdSync() : args.accountId;
  const owner = accountId ?? buildLocalAccountId(args.expectedSignerPubkey);
  const device = getInstallIdSync();
  const envelope = {
    vault_id: args.vaultId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: device },
    device_id: device,
    author_user_id_local_only: author,
    actor_account_id: accountId,
    payload_schema: 1,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local" as const,
  };
  const events: LedgerEvent[] = [
    {
      ...envelope,
      event_id: Crypto.randomUUID(),
      event_type: "vault_member_added",
      target_id: owner,
      payload: {
        account_id: owner,
        role: "owner",
        ...(args.ownerDisplayName !== undefined ? { display_name: args.ownerDisplayName } : {}),
      },
    },
    ...[
      { key: "default_entry_currency", value: args.currency },
      { key: "enabled_currencies", value: JSON.stringify(codes) },
    ].map(
      (payload): LedgerEvent => ({
        ...envelope,
        event_id: Crypto.randomUUID(),
        event_type: "vault_setting_set",
        target_id: args.vaultId,
        payload,
      }),
    ),
  ];
  await applyLocalEventsAtomically(events, {
    expectedSignerPubkey: args.expectedSignerPubkey,
    preflight: async (tx) => {
      if (getAccountIdSync() !== accountId)
        throw new Error("Account changed before creating Kaata");
      if (await tx.getFirstAsync("SELECT id FROM vaults WHERE id=?", args.vaultId))
        throw new Error("The Kaata already exists");
      await initialize(tx);
      if (getAccountIdSync() !== accountId)
        throw new Error("Account changed before creating Kaata");
      const vault = await tx.getFirstAsync<{
        currency: string;
        vault_trust_anchor_pubkey: string | null;
      }>("SELECT currency,vault_trust_anchor_pubkey FROM vaults WHERE id=?", args.vaultId);
      if (
        vault?.currency !== args.currency ||
        vault.vault_trust_anchor_pubkey !== args.expectedSignerPubkey
      )
        throw new Error("New Kaata currency or trust anchor changed");
    },
  });
}
