import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, usePreventRemove, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { assignCustomerGroups } from "../../../lib/customer-groups";
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
  const [draft, setDraft] = useState<{ personId: string; ids: string[] } | null>(null);
  const dirty = useRef<string | null>(null);
  // A group removed meanwhile (Manage groups is one tap away) drops out of the
  // draft; otherwise Done would try to assign a group that no longer exists.
  const liveGroupIds = new Set(state.groups.map((group) => group.id));
  const live = (ids: readonly string[]) =>
    state.loaded ? ids.filter((id) => liveGroupIds.has(id)) : [...ids];
  const saved = live(state.groupsByPerson[params.id] ?? []);
  const selection = draft?.personId === params.id ? live(draft.ids) : saved;
  const found = inScope && Object.hasOwn(state.groupByPerson, params.id);
  // Checks are saved on the way out (Back, swipe, Android back), as they were
  // when each tap saved; only a failed save lets the next Back discard them.
  const changed =
    found &&
    canManage &&
    (selection.length !== saved.length || selection.some((id) => !saved.includes(id)));
  const [discardAllowed, setDiscardAllowed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    if (found && dirty.current !== params.id)
      setDraft({ personId: params.id, ids: state.groupsByPerson[params.id] ?? [] });
  }, [found, params.id, state.groupsByPerson]);
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
  async function save(leave: () => void = () => router.back()) {
    if (!vaultId || !found || !canManage || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const account = getAccountIdSync();
    try {
      await assignCustomerGroups(vaultId, params.id, selection);
      if (current() && getAccountIdSync() === account) {
        setDiscardAllowed(true);
        disablePrevention();
        leave();
      }
    } catch (e) {
      if (current()) {
        setError(
          e instanceof RoleGateRejectionError ? t("entry.roleDenied") : t("entry.saveFailed"),
        );
        setDiscardAllowed(true);
      }
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const disablePrevention = usePreventRemove(changed && !discardAllowed, ({ repeat }) => {
    if (writing.current) return;
    void save(repeat);
  });
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
                selected: group.id === null ? selection.length === 0 : selection.includes(group.id),
                disabled: !canManage || busy,
              }}
              disabled={!canManage || busy}
              onPress={() => {
                dirty.current = params.id;
                const id = group.id;
                setDraft({
                  personId: params.id,
                  ids:
                    id === null
                      ? []
                      : selection.includes(id)
                        ? selection.filter((selected) => selected !== id)
                        : [...selection, id],
                });
              }}
              style={[styles.row, rowDir(isRTL)]}
            >
              <Text style={[styles.label, textDir(isRTL)]}>{group.name}</Text>
              {(group.id === null ? selection.length === 0 : selection.includes(group.id)) ? (
                <Ionicons name="checkmark" size={icon.row} color={colors.actionPrimary} />
              ) : null}
            </Pressable>
          ))
        )}
        {busy ? <ActivityIndicator color={colors.textDefault} /> : null}
        {inScope && error ? <Text style={[styles.error, textDir(isRTL)]}>{error}</Text> : null}
        {canManage ? (
          <View style={styles.manage}>
            <Button
              label={t("groups.manage")}
              accessibilityLabel={t("groups.manage")}
              icon="add-outline"
              variant="secondary"
              fullWidth
              disabled={busy}
              onPress={() => router.push({ pathname: "/groups", params: { vaultId: vaultId! } })}
            />
          </View>
        ) : null}
        {canManage && found ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.done")}
            disabled={busy || !state.loaded || state.failed}
            onPress={() => void save()}
            style={[styles.save, busy && { opacity: 0.6 }]}
          >
            <Text style={styles.saveLabel}>{t("common.done")}</Text>
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
  manage: { marginTop: 24 },
  error: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.danger },
  save: {
    backgroundColor: colors.actionPrimary,
    borderRadius: 12,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 12,
  },
  saveLabel: { fontFamily: fonts.sansSemi, fontSize: 15, color: colors.textInverted },
});
