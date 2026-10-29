import type { ScrollViewInstance, TextInputInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomSheet } from "../components/BottomSheet";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ScreenHeader } from "../components/SettingsScreen";
import { colors } from "../lib/colors";
import {
  archiveCustomerGroup,
  saveCustomerGroup,
  type CustomerGroup,
} from "../lib/customer-groups";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { RoleGateRejectionError } from "../lib/event-log";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { getReducedMotion } from "../lib/reduced-motion";
import { useCustomerGroups } from "../lib/use-customer-groups";
import { useActiveVaultWriteCaps } from "../lib/use-vault-role";
import { icon, radius } from "../lib/tokens";

export default function GroupsScreen() {
  const router = useRouter(),
    isRTL = useIsRTL();
  const params = useLocalSearchParams<{ vaultId?: string }>();
  const [vaultId] = useState(() => params.vaultId ?? getActiveVaultIdSyncMaybe());
  const [viewAccount] = useState(() => getAccountIdSync());
  const { groups, loaded, failed, refresh } = useCustomerGroups(vaultId);
  const caps = useActiveVaultWriteCaps(vaultId);
  const inScope = viewAccount === getAccountIdSync() && vaultId === getActiveVaultIdSyncMaybe();
  const canManage = caps.resolved && caps.canAmend && inScope;
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [selected, setSelected] = useState<CustomerGroup | null>(null);
  const [archiving, setArchiving] = useState<CustomerGroup | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const writing = useRef(false);
  const mounted = useRef(true);
  const nameRef = useRef<TextInputInstance>(null);
  const scrollRef = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Focus by ref after the BottomSheet's modal has gone (CLAUDE.md: autoFocus
  // under a closing modal leaves Android's keyboard shut), and bring the
  // editor, which sits under the list, into view.
  const editorOpen = editing !== null;
  useEffect(() => {
    if (!editorOpen) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({
        animated: !getReducedMotion(),
      });
      nameRef.current?.focus();
    }, 280);
    return () => clearTimeout(timer);
  }, [editorOpen]);
  const current = () =>
    mounted.current &&
    viewAccount === getAccountIdSync() &&
    vaultId === getActiveVaultIdSyncMaybe();
  async function save() {
    if (!vaultId || !editing || !canManage || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const account = getAccountIdSync();
    try {
      await saveCustomerGroup(vaultId, editing.id, editing.name);
      if (!current() || getAccountIdSync() !== account) return;
      setEditing(null);
      await refresh();
    } catch (e) {
      if (current())
        setError(
          e instanceof RoleGateRejectionError
            ? t("entry.roleDenied")
            : e instanceof Error && e.message === "invalid_group_name"
              ? t("groups.nameInvalid")
              : e instanceof Error && e.message === "duplicate_group_name"
                ? t("groups.nameDuplicate")
                : t("entry.saveFailed"),
        );
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function archive() {
    const target = archiving;
    setArchiving(null);
    if (!vaultId || !target || !canManage || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      await archiveCustomerGroup(vaultId, target.id);
      if (current()) await refresh();
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
      <ScreenHeader title={t("groups.manage")} onBack={() => router.back()} isRTL={isRTL} />
      {/* Android does not resize for the keyboard (edge-to-edge); iOS adjusts
          the ScrollView's insets itself, so the KAV is Android-only. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.body}
        >
          <Text style={[styles.hint, textDir(isRTL)]}>{t("groups.help")}</Text>
          {failed ? (
            <Text style={[styles.error, textDir(isRTL)]}>{t("home.loadFailed")}</Text>
          ) : null}
          {!loaded ? (
            <ActivityIndicator color={colors.textDefault} />
          ) : inScope ? (
            groups.map((group) => (
              <View key={group.id} style={[styles.groupRow, rowDir(isRTL)]}>
                {/* Opens who is in the group, where several customers can be
                    put in or taken out at once. */}
                <Pressable
                  style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityHint={t("groups.members.open")}
                  disabled={busy}
                  onPress={() =>
                    router.push({
                      pathname: "/group-members",
                      params: { vaultId: vaultId!, groupId: group.id },
                    })
                  }
                >
                  <Text style={[styles.name, textDir(isRTL)]}>{group.name}</Text>
                  <Text style={[styles.hint, textDir(isRTL)]}>
                    {t(group.member_count === 1 ? "groups.memberCountOne" : "groups.memberCount", {
                      count: group.member_count,
                    })}
                  </Text>
                </Pressable>
                {canManage ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("groups.edit", { name: group.name })}
                    disabled={busy}
                    onPress={() => setSelected(group)}
                    style={styles.more}
                  >
                    <Ionicons
                      name="ellipsis-horizontal"
                      size={icon.row}
                      color={colors.textDefault}
                    />
                  </Pressable>
                ) : null}
              </View>
            ))
          ) : null}
          {inScope && loaded && !failed && groups.length === 0 ? (
            <Text style={[styles.hint, textDir(isRTL)]}>{t("groups.empty")}</Text>
          ) : null}
          {canManage && editing ? (
            <View style={styles.editor}>
              <TextInput
                ref={nameRef}
                value={editing.name}
                onChangeText={(name) => setEditing({ ...editing, name })}
                editable={!busy}
                placeholder={t("groups.namePlaceholder")}
                accessibilityLabel={t("groups.name")}
                maxLength={80}
                style={[styles.input, textDir(isRTL)]}
              />
              <View style={[styles.actions, rowDir(isRTL)]}>
                <Button label={t("entry.save")} onPress={() => void save()} loading={busy} />
                <Pressable
                  disabled={busy}
                  onPress={() => {
                    setEditing(null);
                    setError(null);
                  }}
                  style={styles.cancel}
                >
                  <Text style={styles.name}>{t("common.cancel")}</Text>
                </Pressable>
              </View>
            </View>
          ) : canManage ? (
            <Pressable
              disabled={busy}
              style={[styles.add, rowDir(isRTL)]}
              accessibilityRole="button"
              onPress={() => {
                setEditing({ id: null, name: "" });
                setError(null);
              }}
            >
              <Ionicons name="add" size={icon.row} color={colors.textDefault} />
              <Text style={styles.name}>{t("groups.add")}</Text>
            </Pressable>
          ) : null}
          {inScope && error ? <Text style={[styles.error, textDir(isRTL)]}>{error}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <BottomSheet
        visible={canManage && selected !== null}
        title={canManage ? selected?.name : undefined}
        onDismiss={() => setSelected(null)}
        actions={[
          {
            label: t("groups.rename"),
            icon: "create-outline",
            disabled: !canManage,
            onPress: () => {
              if (current() && selected) setEditing({ id: selected.id, name: selected.name });
            },
          },
          {
            label: t("groups.archive"),
            icon: "archive-outline",
            destructive: true,
            disabled: !canManage,
            onPress: () => {
              if (current()) setArchiving(selected);
            },
          },
        ]}
      />
      <ConfirmDialog
        visible={canManage && archiving !== null}
        title={t("groups.archiveTitle", { name: canManage ? (archiving?.name ?? "") : "" })}
        description={t("groups.archiveHelp")}
        confirmLabel={t("groups.archive")}
        destructive
        onConfirm={() => void archive()}
        onCancel={() => setArchiving(null)}
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20, gap: 16 },
  hint: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.textSubtle, lineHeight: 21 },
  name: { fontFamily: fonts.sansRegular, fontSize: 15, color: colors.textDefault },
  groupRow: {
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  more: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  add: { alignItems: "center", gap: 8, minHeight: 48 },
  editor: { gap: 12 },
  input: {
    fontFamily: fonts.sansRegular,
    fontSize: 16,
    color: colors.textDefault,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    padding: 14,
  },
  actions: { alignItems: "center", gap: 20 },
  cancel: { padding: 12 },
  error: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.danger },
});
