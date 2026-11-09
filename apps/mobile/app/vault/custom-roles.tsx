import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { OptionSheet } from "../../components/OptionSheet";
import { ScreenLoading } from "../../components/ScreenLoading";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import {
  applyForCurrentSession,
  captureCurrentSession,
  type SessionSnapshot,
} from "../../lib/auth";
import { colors } from "../../lib/colors";
import { customRolePresetName, customRoleText as copy } from "../../lib/custom-role-copy";
import {
  getActiveVaultIdSyncMaybe,
  getSessionAccountIdSync,
  onAccountIdentityChanged,
} from "../../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { isPlaceholderSelfName, t } from "../../lib/i18n";
import { radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { listVaults } from "../../lib/vault-api";
import {
  assignCustomRole,
  customRolePermissionsForPreset,
  deleteCustomRole,
  readCustomRoles,
  saveCustomRole,
  type CustomRolePermission,
  type CustomRolePreset,
  type CustomRoleSnapshot,
  type CustomVaultRole,
} from "../../lib/vault-custom-roles";

const presets: CustomRolePreset[] = ["manager", "editor", "clerk", "viewer"];
const permissionGroups = [
  { label: "tally", permissions: ["entry.create", "entry.amend", "entry.delete"] },
  { label: "customers", permissions: ["person.add", "person.edit", "group.manage"] },
  { label: "notes", permissions: ["tally_note.add", "tally_note.remove"] },
  { label: "kaata", permissions: ["vault.settings", "vault.members"] },
] as const satisfies ReadonlyArray<{
  label: "tally" | "customers" | "notes" | "kaata";
  permissions: readonly CustomRolePermission[];
}>;

const nameLimit = 40;
const roleLimit = 32;
const presetOnly = "preset";

type Member = { id: string; name: string; preset: CustomRolePreset };
type Draft = Omit<CustomVaultRole, "id"> & { id?: string };
type RoleView = {
  scope: string;
  session: SessionSnapshot;
  snapshot: CustomRoleSnapshot;
  members: Member[];
  kaataName: string;
};

function isPreset(value: string): value is CustomRolePreset {
  return presets.some((preset) => preset === value);
}

function newDraft(preset: CustomRolePreset): Draft {
  return { name: "", base_role: preset, permissions: [...customRolePermissionsForPreset(preset)] };
}

function failureCopy(error: unknown): string {
  const reason = error && typeof error === "object" && "reason" in error ? error.reason : null;
  if (reason === "custom_role_name_taken") return copy("duplicate");
  if (reason === "custom_role_limit") return copy("limit");
  if (reason === "custom_role_in_use") return copy("deleteAssigned");
  return copy("changed");
}

export default function VaultCustomRolesScreen() {
  const router = useRouter();
  const rtl = useIsRTL();
  const toast = useToast();
  const params = useLocalSearchParams<{ vaultId?: string; memberId?: string }>();
  const vaultId = typeof params.vaultId === "string" ? params.vaultId : "";
  const identityRevision = useRef(0);
  const subscribeIdentity = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        identityRevision.current++;
        notify();
      }),
    [],
  );
  const readIdentity = useCallback(
    () => `${identityRevision.current}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribeIdentity, readIdentity, readIdentity);
  const scope = `${vaultId}:${identity}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [storedView, setView] = useState<RoleView | null>(null);
  const [loadError, setLoadError] = useState<"ownerOnly" | "unavailable" | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [presetPicker, setPresetPicker] = useState(false);
  const [memberId, setMemberId] = useState<string | null>(
    typeof params.memberId === "string" ? params.memberId : null,
  );
  const [deleteTarget, setDeleteTarget] = useState<CustomVaultRole | null>(null);
  const requestId = useRef(0);
  const focused = useRef(false);
  const mutationPending = useRef(false);

  const view = storedView?.scope === scope ? storedView : null;
  const current = useCallback(
    (id: number) =>
      focused.current &&
      requestId.current === id &&
      scopeRef.current === scope &&
      getActiveVaultIdSyncMaybe() === vaultId,
    [scope, vaultId],
  );

  const load = useCallback(
    async (expected?: SessionSnapshot) => {
      const id = ++requestId.current;
      const stillFocused = () =>
        focused.current && requestId.current === id && scopeRef.current === scope;
      setLoading(true);
      setLoadError(null);
      try {
        const session = expected ?? (await captureCurrentSession());
        if (!stillFocused()) return;
        if (
          !vaultId ||
          !session.jwt ||
          !session.accountId ||
          getActiveVaultIdSyncMaybe() !== vaultId
        ) {
          setView(null);
          setLoadError("ownerOnly");
          return;
        }
        const listing = (await listVaults(session)).find((row) => row.vault_id === vaultId);
        if (!current(id)) return;
        if (!listing || listing.role !== "owner" || listing.archived_at_ms != null) {
          setView(null);
          setLoadError("ownerOnly");
          return;
        }
        if (!Array.isArray(listing.members)) throw new Error("Missing member listing");
        const snapshot = await readCustomRoles(vaultId, session);
        await applyForCurrentSession(session, async () => {
          if (!current(id)) return;
          const members: Member[] = [];
          const seen = new Set<string>();
          for (const row of listing.members ?? []) {
            if (
              !row ||
              typeof row.account_id !== "string" ||
              !row.account_id ||
              row.account_id === session.accountId ||
              seen.has(row.account_id) ||
              !isPreset(row.role)
            )
              continue;
            seen.add(row.account_id);
            const name = typeof row.name === "string" ? row.name.trim() : "";
            members.push({
              id: row.account_id,
              preset: row.role,
              name: name && !isPlaceholderSelfName(name) ? name : t("members.nameUnavailable"),
            });
          }
          setView({ scope, session, snapshot, members, kaataName: listing.name });
        });
      } catch {
        if (stillFocused()) {
          setView(null);
          setLoadError("unavailable");
        }
      } finally {
        if (stillFocused()) setLoading(false);
      }
    },
    [current, scope, vaultId],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setView(null);
      setDraft(null);
      setPresetPicker(false);
      setDeleteTarget(null);
      setBusy(mutationPending.current);
      void load();
      return () => {
        focused.current = false;
        requestId.current++;
        setMemberId(null);
      };
    }, [load]),
  );

  const onBack = () => {
    if (draft && view) setDraft(null);
    else router.back();
  };

  async function mutate(
    work: (session: SessionSnapshot) => Promise<unknown>,
    success: "saved" | "assignedSaved" | "deleted",
    afterSave?: () => void,
  ) {
    if (!view || loading || mutationPending.current) return;
    const id = requestId.current;
    if (!current(id)) return;
    mutationPending.current = true;
    setBusy(true);
    try {
      await work(view.session);
      if (!current(id)) return;
      toast.push(copy(success), "success");
      afterSave?.();
      await load(view.session);
    } catch (error) {
      if (current(id)) {
        toast.push(failureCopy(error), "error");
        // Reconcile a timed-out mutation before the owner can retry it.
        await load(view.session);
      }
    } finally {
      mutationPending.current = false;
      if (focused.current) setBusy(false);
    }
  }

  if (!view && loading) {
    return (
      <ScreenLoading title={copy("title")} onBack={onBack} isRTL={rtl} edges={["top", "bottom"]} />
    );
  }

  const locked = busy || loading;
  const roles = view?.snapshot.roles ?? [];
  const assignments = view?.snapshot.assignments ?? [];
  const activeMember = view?.members.find((member) => member.id === memberId);
  const matchingRoles = activeMember
    ? roles.filter((role) => role.base_role === activeMember.preset)
    : [];
  const activeAssignment = assignments.find(
    (assignment) => assignment.account_id === activeMember?.id,
  )?.role_id;
  const allowed = new Set(draft ? customRolePermissionsForPreset(draft.base_role) : []);
  const deleteBlocked =
    !!draft?.id && assignments.some((assignment) => assignment.role_id === draft.id);
  const persistedDraft = draft?.id ? roles.find((role) => role.id === draft.id) : undefined;

  function saveDraft() {
    if (!draft || !draft.name.trim() || locked) return;
    const { id, name, base_role, permissions } = draft;
    void mutate(
      (session) =>
        saveCustomRole(vaultId, { name: name.trim(), base_role, permissions }, id, session),
      "saved",
      () => setDraft(null),
    );
  }

  function chooseAssignment(id: string) {
    setMemberId(null);
    if (!activeMember || locked) return;
    const roleId = id === presetOnly ? null : id;
    if (
      (activeAssignment ?? null) === roleId ||
      (roleId && !matchingRoles.some((role) => role.id === roleId))
    )
      return;
    void mutate(
      (session) => assignCustomRole(vaultId, activeMember.id, roleId, session),
      "assignedSaved",
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <ScreenHeader
        title={view && draft ? copy(draft.id ? "edit" : "add") : copy("title")}
        onBack={onBack}
        backDisabled={busy}
        isRTL={rtl}
      />
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            view && !draft ? (
              <RefreshControl
                refreshing={loading}
                onRefresh={() => {
                  if (!locked) void load(view.session);
                }}
              />
            ) : undefined
          }
        >
          {!view ? (
            <View style={styles.panel}>
              <Text style={[styles.hint, textDir(rtl)]}>{copy(loadError ?? "unavailable")}</Text>
              <Button
                label={t("common.retry")}
                variant="secondary"
                onPress={() => void load()}
                wrapLabel
              />
            </View>
          ) : draft ? (
            <>
              <View style={styles.panel}>
                <Text style={[styles.label, textDir(rtl)]}>{copy("name")}</Text>
                <TextInput
                  accessibilityLabel={copy("name")}
                  autoCapitalize="sentences"
                  editable={!locked}
                  onChangeText={(name) =>
                    setDraft({ ...draft, name: Array.from(name).slice(0, nameLimit).join("") })
                  }
                  placeholder={copy("placeholder")}
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, textDir(rtl)]}
                  value={draft.name}
                />
              </View>
              <NavRow
                icon="options-outline"
                label={copy("preset")}
                trailing={customRolePresetName(draft.base_role)}
                isRTL={rtl}
                disabled={locked || Boolean(draft.id)}
                onPress={() => setPresetPicker(true)}
                isLast
              />
              <EmptyHint label={copy("presetHelp")} isRTL={rtl} />
              {permissionGroups.map((group) => {
                const permissions = group.permissions.filter((permission) =>
                  allowed.has(permission),
                );
                if (!permissions.length) return null;
                return (
                  <View key={group.label}>
                    <SectionHeader label={copy(group.label)} isRTL={rtl} />
                    {permissions.map((permission) => (
                      <View key={permission} style={[styles.switchRow, rowDir(rtl)]}>
                        <Text style={[styles.switchLabel, textDir(rtl)]}>{copy(permission)}</Text>
                        <Switch
                          accessibilityLabel={copy(permission)}
                          disabled={locked}
                          onValueChange={(enabled) =>
                            setDraft({
                              ...draft,
                              permissions: enabled
                                ? [...new Set([...draft.permissions, permission])]
                                : draft.permissions.filter((value) => value !== permission),
                            })
                          }
                          value={draft.permissions.includes(permission)}
                          trackColor={{ false: colors.borderDefault, true: colors.actionPrimary }}
                        />
                      </View>
                    ))}
                  </View>
                );
              })}
              <View style={styles.panel}>
                <Button
                  label={t("entry.save")}
                  onPress={saveDraft}
                  disabled={locked || !draft.name.trim()}
                  loading={busy}
                  wrapLabel
                />
              </View>
              {persistedDraft ? (
                <NavRow
                  icon="trash-outline"
                  label={copy("delete")}
                  hint={deleteBlocked ? copy("deleteAssigned") : undefined}
                  hintLines={3}
                  isRTL={rtl}
                  danger
                  disabled={locked || deleteBlocked}
                  onPress={() => setDeleteTarget(persistedDraft)}
                  isLast
                />
              ) : null}
            </>
          ) : (
            <>
              <View style={styles.panel}>
                <Text style={[styles.label, textDir(rtl)]}>{view.kaataName}</Text>
                <Text style={[styles.hint, textDir(rtl)]}>{copy("intro")}</Text>
                <Button
                  icon="add"
                  label={copy("add")}
                  onPress={() => setDraft(newDraft("clerk"))}
                  disabled={locked || roles.length >= roleLimit}
                  wrapLabel
                />
                {roles.length >= roleLimit ? (
                  <Text style={[styles.hint, textDir(rtl)]}>{copy("limit")}</Text>
                ) : null}
              </View>
              <SectionHeader label={copy("roles")} isRTL={rtl} />
              {roles.length ? (
                roles.map((role, index) => (
                  <NavRow
                    key={role.id}
                    icon="shield-outline"
                    label={role.name}
                    hint={copy("assigned", {
                      count: assignments.filter((assignment) => assignment.role_id === role.id)
                        .length,
                      role: customRolePresetName(role.base_role),
                    })}
                    onPress={() => setDraft({ ...role, permissions: [...role.permissions] })}
                    isRTL={rtl}
                    disabled={locked}
                    isLast={index === roles.length - 1}
                  />
                ))
              ) : (
                <EmptyHint label={copy("empty")} isRTL={rtl} />
              )}
              <SectionGap />
              <SectionHeader label={copy("members")} isRTL={rtl} />
              {view.members.length ? (
                view.members.map((member, index) => {
                  const assignment = assignments.find((row) => row.account_id === member.id);
                  const role = roles.find((candidate) => candidate.id === assignment?.role_id);
                  const memberPreset = customRolePresetName(member.preset);
                  return (
                    <NavRow
                      key={member.id}
                      icon="person-outline"
                      label={member.name}
                      hint={role ? copy("current") + " · " + memberPreset : memberPreset}
                      trailing={role?.name}
                      onPress={() => setMemberId(member.id)}
                      isRTL={rtl}
                      disabled={locked}
                      isLast={index === view.members.length - 1}
                    />
                  );
                })
              ) : (
                <EmptyHint label={copy("membersEmpty")} isRTL={rtl} />
              )}
              {memberId && !activeMember ? (
                <EmptyHint label={copy("memberUnavailable")} isRTL={rtl} />
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <OptionSheet
        visible={!!(view && draft && presetPicker)}
        title={copy("preset")}
        options={presets.map((preset) => ({ key: preset, label: customRolePresetName(preset) }))}
        selected={draft?.base_role ?? "clerk"}
        onSelect={(preset) => {
          if (draft && !draft.id && !locked && isPreset(preset) && preset !== draft.base_role) {
            setDraft({ ...newDraft(preset), name: draft.name });
          }
          setPresetPicker(false);
        }}
        onDismiss={() => setPresetPicker(false)}
        isRTL={rtl}
      />
      <OptionSheet
        visible={!!activeMember && !draft && !locked}
        title={activeMember?.name ?? copy("members")}
        options={[
          {
            key: presetOnly,
            label: copy("presetOnly"),
            hint:
              !matchingRoles.length && activeMember
                ? copy("noMatching", { role: customRolePresetName(activeMember.preset) })
                : copy("presetOnlyHint"),
          },
          ...matchingRoles.map((role) => ({ key: role.id, label: role.name })),
        ]}
        selected={activeAssignment ?? presetOnly}
        onSelect={chooseAssignment}
        onDismiss={() => setMemberId(null)}
        isRTL={rtl}
      />
      <ConfirmDialog
        visible={!!deleteTarget && !!view && !locked}
        title={copy("delete")}
        description={copy("deleteBody", { name: deleteTarget?.name ?? "" })}
        confirmLabel={copy("delete")}
        destructive
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target)
            void mutate(
              (session) => deleteCustomRole(vaultId, target.id, session),
              "deleted",
              () => setDraft(null),
            );
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDefault },
  fill: { flex: 1 },
  content: { paddingBottom: 24 },
  panel: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  label: { ...typography.label, color: colors.textEmphasis },
  hint: { ...typography.body, color: colors.textSubtle },
  input: {
    ...typography.body,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    color: colors.textDefault,
  },
  switchRow: {
    alignItems: "center",
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  switchLabel: { ...typography.body, flex: 1, color: colors.textDefault },
});
