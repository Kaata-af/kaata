import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import EntryFormScreen from "../new";
import { ScreenLoading } from "../../../components/ScreenLoading";
import { getEntry } from "../../../lib/db";
import {
  getAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  getInstallIdSync,
} from "../../../lib/db-tx";
import { useIsRTL } from "../../../lib/direction";
import { t } from "../../../lib/i18n";
import { getTabLinkForRelationship } from "../../../lib/tabs/db";
import type { Entry } from "../../../lib/types";

const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

// Add and Edit share one calculator and keyboard owner. Scope the initial
// read so a late result cannot open a different account or book's tally.
export default function EditEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isRTL = useIsRTL();
  const vaultId = getActiveVaultIdSyncMaybe();
  const accountId = getAccountIdSync();
  const installId = getInstallIdSync();
  const scopeKey = JSON.stringify([id, vaultId, accountId, installId]);
  const latestScope = useRef(scopeKey);
  latestScope.current = scopeKey;
  const [loaded, setLoaded] = useState<{
    scope: string;
    entry?: Entry;
    personId?: string;
    locked?: boolean;
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const current = () =>
        active &&
        latestScope.current === scopeKey &&
        getActiveVaultIdSyncMaybe() === vaultId &&
        getAccountIdSync() === accountId &&
        getInstallIdSync() === installId;
      setLoaded(null);
      void (async () => {
        try {
          const entry = id && vaultId ? await getEntry(id) : null;
          if (!current()) return;
          if (!entry) {
            setLoaded({ scope: scopeKey });
            return;
          }
          const db = await getDb();
          if (!current()) return;
          const relationship = await db.getFirstAsync<{ person_id: string }>(
            "SELECT user_b_id AS person_id FROM relationships WHERE id=? AND vault_id=? AND archived_at IS NULL",
            entry.relationship_id,
            vaultId,
          );
          if (!current()) return;
          const link = await getTabLinkForRelationship(entry.relationship_id, entry.currency);
          if (!current()) return;
          setLoaded({
            scope: scopeKey,
            entry: relationship ? entry : undefined,
            personId: relationship?.person_id,
            locked: Boolean(link),
          });
        } catch (error) {
          if (!current()) return;
          console.warn("[entry/edit] load failed", error);
          setLoaded({ scope: scopeKey });
        }
      })();
      return () => {
        active = false;
      };
    }, [id, vaultId, accountId, installId, scopeKey]),
  );

  if (loaded?.scope === scopeKey && loaded.entry && loaded.personId && !loaded.locked)
    return (
      <EntryFormScreen key={scopeKey} editingEntry={loaded.entry} editPersonId={loaded.personId} />
    );

  return (
    <ScreenLoading
      title={t("entry.edit.title", { verb: t("person.action.iGave") })}
      onBack={() => router.back()}
      isRTL={isRTL}
      message={
        loaded?.scope === scopeKey
          ? t(loaded.locked ? "tab.editLocked" : "entry.notFound")
          : undefined
      }
      edges={MODAL_EDGES}
    />
  );
}
