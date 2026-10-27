import { useFocusEffect, useRouter, type Href } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { ProfileSettingsSheet } from "../components/ProfileSettingsSheet";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../lib/db-tx";
import { useProfileSettingsSource, useProfileSettingsStore } from "../lib/profile-settings-context";

export default function ProfileScreen() {
  const router = useRouter();
  const store = useProfileSettingsStore();
  const source = useProfileSettingsSource();
  const focused = useRef(true);
  const opened = useRef<{ owner: object; account: string | null; vault: string | null } | null>(
    null,
  );
  const leaving = useRef(false);
  const current = () => {
    const live = store.getSnapshot();
    return live?.ready &&
      live.props.activeAccountId === getAccountIdSync() &&
      live.props.activeVaultId === getActiveVaultIdSyncMaybe() &&
      (!opened.current ||
        (live.owner === opened.current.owner &&
          live.props.activeAccountId === opened.current.account &&
          live.props.activeVaultId === opened.current.vault))
      ? live
      : null;
  };
  const live = current();
  if (live && !opened.current)
    opened.current = {
      owner: live.owner,
      account: live.props.activeAccountId,
      vault: live.props.activeVaultId,
    };

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const source = store.getSnapshot();
      if (
        source?.ready &&
        source.props.activeAccountId === getAccountIdSync() &&
        source.props.activeVaultId === getActiveVaultIdSyncMaybe()
      )
        source.onPresent?.();
      return () => {
        focused.current = false;
        const latest = store.getSnapshot();
        if (!leaving.current && latest && latest.owner === opened.current?.owner) {
          leaving.current = true;
          latest.props.onDismiss();
        }
      };
    }, [store]),
  );

  useEffect(() => {
    if (live || leaving.current) return;
    leaving.current = true;
    if (opened.current) {
      const latest = store.getSnapshot();
      if (latest?.owner === opened.current.owner) latest.props.onDismiss();
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } else {
      // Cold/deep links first mount Home's real data/actions, then consume this
      // one-shot intent after its current account/vault snapshot is ready.
      router.replace({ pathname: "/", params: { menu: "profile" } });
    }
  }, [live, router]);

  function claim() {
    const snapshot = current();
    if (!focused.current || leaving.current || !snapshot) return null;
    leaving.current = true;
    snapshot.props.onDismiss();
    return snapshot;
  }
  function navigate(path: Href) {
    if (claim()) router.replace(path);
  }
  function close(action?: (props: NonNullable<typeof source>["props"]) => void) {
    const snapshot = claim();
    if (!snapshot) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
    action?.(snapshot.props);
  }

  if (!live || !focused.current) return null;
  return (
    <ProfileSettingsSheet
      {...live.props}
      visible={focused.current}
      onDismiss={() => close()}
      onNavigate={navigate}
      onOpenAccount={() => navigate("/account")}
      onManageCurrentKaata={() => navigate("/vault/settings")}
      onOpenArchived={() => navigate("/vault/archived")}
      onAddVault={() => navigate("/vault/new")}
      onScanPairingCode={() => navigate("/vault/pair-scan")}
      onSelectVault={(id) => close((props) => props.onSelectVault(id))}
      onSignOut={() => close((props) => props.onSignOut())}
      onToggleShopMode={(next) => {
        if (current() && !leaving.current) live.props.onToggleShopMode(next);
      }}
    />
  );
}
