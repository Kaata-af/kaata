import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { getAccountIdSync } from "../lib/db-tx";
import { t } from "../lib/i18n";
import { readVaultRole } from "../lib/use-vault-role";
import { PersonalBackupSetup } from "./PersonalBackupSetup";
import { useToast } from "./Toast";

type BackupService = typeof import("../lib/personal-cloud-backup");
const NO_OTHER_VAULTS: readonly { id: string }[] = [];

export function HomePersonalBackupOffer({
  accountId,
  activeVaultId,
  ownsActiveVault,
  vaults,
  visible,
}: {
  accountId: string | null;
  activeVaultId: string;
  ownsActiveVault: boolean;
  vaults: readonly { id: string }[];
  visible: boolean;
}) {
  const toast = useToast();
  const [offer, setOffer] = useState<BackupService | null>(null);
  const focus = useRef<symbol | null>(null);
  const dismissed = useRef(false);
  const otherVaults = ownsActiveVault ? NO_OTHER_VAULTS : vaults;

  useFocusEffect(useCallback(() => {
    const token = Symbol();
    focus.current = token;
    setOffer(null);
    const current = () => focus.current === token && getAccountIdSync() === accountId;
    void (async () => {
      if (dismissed.current || (!ownsActiveVault && !otherVaults.some(({ id }) => id !== activeVaultId)))
        return null;
      const service = await import("../lib/personal-cloud-backup");
      if (!current() || !await service.shouldOfferPersonalCloudBackup(accountId)) return null;
      if (ownsActiveVault) return service;
      // A member may be viewing a shared Kaata while owning another one.
      for (const { id } of otherVaults) {
        if (!current()) return null;
        if (id !== activeVaultId && await readVaultRole(id, accountId) === "owner") return service;
      }
      return null;
    })().then(
      (service) => { if (current()) setOffer(dismissed.current ? null : service); },
      () => { if (current()) setOffer(null); },
    );
    return () => { focus.current = null; };
  }, [accountId, activeVaultId, ownsActiveVault, otherVaults]));

  if (!visible || !offer || !focus.current || getAccountIdSync() !== accountId) return null;
  return (
    <PersonalBackupSetup
      placement="home"
      onDismiss={() => {
        if (!focus.current || dismissed.current || getAccountIdSync() !== accountId) return;
        dismissed.current = true;
        setOffer(null);
        void offer.dismissPersonalCloudBackupOffer(accountId).catch(() => {
          dismissed.current = false;
          if (!focus.current || getAccountIdSync() !== accountId) return;
          setOffer(offer);
          toast.push(t("entry.saveFailed"), "error");
        });
      }}
    />
  );
}
