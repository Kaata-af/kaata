import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { assignCustomerGroup } from "../../../lib/customer-groups";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../../../lib/db-tx";
import { colors } from "../../../lib/colors";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { RoleGateRejectionError } from "../../../lib/event-log";
import { fonts } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { useCustomerGroups } from "../../../lib/use-customer-groups";
import { useActiveVaultWriteCaps } from "../../../lib/use-vault-role";
import { icon } from "../../../lib/tokens";

export default function PersonGroupScreen() {
  const router = useRouter(),
    isRTL = useIsRTL(),
    params = useLocalSearchParams<{ id: string; vaultId?: string }>();
  const [vaultId] = useState(() => params.vaultId ?? getActiveVaultIdSyncMaybe());
  const [viewAccount] = useState(() => getAccountIdSync());
  const state = useCustomerGroups(vaultId),
    caps = useActiveVaultWriteCaps(vaultId);
  const inScope = viewAccount === getAccountIdSync() && vaultId === getActiveVaultIdSyncMaybe();
  const canManage = caps.resolved && caps.canAmend && inScope;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    writing = useRef(false);
  const found = inScope && Object.hasOwn(state.groupByPerson, params.id);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    viewAccount === getAccountIdSync() &&
    vaultId === getActiveVaultIdSyncMaybe();
  async function select(groupId: string | null) {
    if (!vaultId || !found || !canManage || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const account = getAccountIdSync();
    try {
      await assignCustomerGroup(vaultId, params.id, groupId);
      if (current() && getAccountIdSync() === account) router.back();
    } catch (e) {
      if (current())
        setError(
          e instanceof RoleGateRejectionError ? t("entry.roleDenied") : t("entry.saveFailed"),
        );
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <ScreenHeader
        title={t("groups.personAction")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.hint, textDir(isRTL)]}>{t("groups.personHelp")}</Text>
        {!state.loaded ? (
          <ActivityIndicator color={colors.textDefault} />
        ) : state.failed ? (
          <Text style={[styles.error, textDir(isRTL)]}>{t("home.loadFailed")}</Text>
        ) : !found ? (
          <Text style={[styles.hint, textDir(isRTL)]}>{t("personAdd.personNotFound")}</Text>
        ) : (
          [{ id: null, name: t("groups.none") }, ...state.groups].map((group) => (
            <Pressable
              key={group.id ?? "none"}
              accessibilityRole="button"
              accessibilityLabel={group.name}
              accessibilityState={{
                selected: state.groupByPerson[params.id] === group.id,
                disabled: !canManage || busy,
              }}
              disabled={!canManage || busy}
              onPress={() => void select(group.id)}
              style={[styles.row, rowDir(isRTL)]}
            >
              <Text style={[styles.label, textDir(isRTL)]}>{group.name}</Text>
              {state.groupByPerson[params.id] === group.id ? (
                <Ionicons name="checkmark" size={icon.row} color={colors.actionPrimary} />
              ) : null}
            </Pressable>
          ))
        )}
        {busy ? <ActivityIndicator color={colors.textDefault} /> : null}
        {inScope && error ? <Text style={[styles.error, textDir(isRTL)]}>{error}</Text> : null}
        {canManage ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={styles.manage}
            onPress={() => router.push({ pathname: "/groups", params: { vaultId: vaultId! } })}
          >
            <Text style={[styles.label, textDir(isRTL)]}>{t("groups.manage")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20 },
  hint: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textSubtle,
    lineHeight: 21,
    marginBottom: 20,
  },
  row: {
    minHeight: 52,
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  label: { fontFamily: fonts.sansRegular, fontSize: 15, color: colors.textDefault, flex: 1 },
  manage: { paddingVertical: 20 },
  error: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.danger },
});
