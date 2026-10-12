import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Button } from "../components/Button";
import { ScreenHeader } from "../components/SettingsScreen";
import { colors } from "../lib/colors";
import { splitSearchQuery } from "../lib/contacts-merge";
import { assignCustomerGroups } from "../lib/customer-groups";
import { compareCustomerNames } from "../lib/customer-list";
import { listAllPeopleForSearch } from "../lib/db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../lib/db-tx";
import { ltrIsolate } from "../lib/bidi";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { RoleGateRejectionError } from "../lib/event-log";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { searchContacts } from "../lib/search";
import { icon, radius } from "../lib/tokens";
import type { PersonWithBalance } from "../lib/types";
import { useCustomerGroups } from "../lib/use-customer-groups";
import { useActiveVaultWriteCaps } from "../lib/use-vault-role";

// Who is in one group, and many customers in or out of it at once (the
// customer's own picker changes one person at a time). Every role can look;
// only owner/manager/editor tick. Ticks are saved on Done or on the way out,
// like the customer's picker; a failed save lets the next Back discard.
export default function GroupMembersScreen() {
  const router = useRouter(),
    navigation = useNavigation(),
    isRTL = useIsRTL();
  const params = useLocalSearchParams<{ vaultId?: string; groupId: string }>();
  const [vaultId] = useState(() => params.vaultId ?? getActiveVaultIdSyncMaybe());
  const [viewAccount] = useState(() => getAccountIdSync());
  const state = useCustomerGroups(vaultId);
  const caps = useActiveVaultWriteCaps(vaultId);
  const inScope = viewAccount === getAccountIdSync() && vaultId === getActiveVaultIdSyncMaybe();
  const canManage = caps.resolved && caps.canAmend && inScope;
  const group = state.groups.find((candidate) => candidate.id === params.groupId) ?? null;
  const [people, setPeople] = useState<PersonWithBalance[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  // Desired membership per touched customer; untouched rows follow storage.
  const [desired, setDesired] = useState<Map<string, boolean>>(() => new Map());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [discardAllowed, setDiscardAllowed] = useState(false);
  const writing = useRef(false),
    leaving = useRef(false),
    mounted = useRef(true);
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
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (!vaultId) return;
      listAllPeopleForSearch(vaultId)
        .then((rows) => {
          if (!alive || !current()) return;
          setPeople(rows);
          setLoadFailed(false);
        })
        .catch(() => {
          if (alive && current()) setLoadFailed(true);
        });
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultId]),
  );

  const stored = (personId: string) =>
    (state.groupsByPerson[personId] ?? []).includes(params.groupId);
  const member = (personId: string) => desired.get(personId) ?? stored(personId);
  const pending = [...desired].filter(([personId, want]) => want !== stored(personId));
  const changed = canManage && group != null && pending.length > 0;
  const memberCount = (people ?? []).filter((person) => member(person.id)).length;

  const rows = useMemo(() => {
    const locale = getLocale();
    const all = people ?? [];
    const searched = query.trim()
      ? (() => {
          const q = splitSearchQuery(query);
          const ids = new Set(searchContacts(q.first, q.last, q.phoneDigits, all).map((p) => p.id));
          return all.filter((person) => ids.has(person.id));
        })()
      : all;
    // Members first by what is SAVED, so a row never jumps when it is ticked.
    const visible = canManage ? searched : searched.filter((person) => stored(person.id));
    return [...visible].sort(
      (a, b) =>
        Number(stored(b.id)) - Number(stored(a.id)) || compareCustomerNames(a.name, b.name, locale),
    );
    // stored() reads state.groupsByPerson and params.groupId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, query, canManage, state.groupsByPerson, params.groupId]);

  async function save(leave: () => void = () => router.back()) {
    if (!vaultId || !group || !canManage || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const account = getAccountIdSync();
    try {
      for (const [personId, want] of pending) {
        const ids = state.groupsByPerson[personId] ?? [];
        await assignCustomerGroups(
          vaultId,
          personId,
          want ? [...ids, params.groupId] : ids.filter((id) => id !== params.groupId),
        );
      }
      if (current() && getAccountIdSync() === account) {
        leaving.current = true;
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
  usePreventRemove(changed && !discardAllowed, ({ data }) => {
    // The re-dispatched action is marked as already asked for this screen.
    if (leaving.current) return navigation.dispatch(data.action);
    if (writing.current) return;
    void save(() => navigation.dispatch(data.action));
  });

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <ScreenHeader
        title={group?.name ?? t("groups.manage")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      {/* Android does not resize for the keyboard (edge-to-edge); iOS adjusts
          the ScrollView's insets itself, so the KAV is Android-only. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.body}
        >
          {!state.loaded || (people === null && !loadFailed) ? (
            <ActivityIndicator color={colors.textDefault} />
          ) : state.failed || loadFailed ? (
            <Text style={[styles.error, textDir(isRTL)]}>{t("home.loadFailed")}</Text>
          ) : !inScope || !group ? (
            <Text style={[styles.hint, textDir(isRTL)]}>{t("groups.members.missing")}</Text>
          ) : (
            <>
              <Text style={[styles.hint, textDir(isRTL)]}>
                {canManage ? t("groups.members.help") : t("groups.members.viewHelp")}
              </Text>
              <Text style={[styles.count, textDir(isRTL)]}>
                {t(memberCount === 1 ? "groups.memberCountOne" : "groups.memberCount", {
                  count: memberCount,
                })}
              </Text>
              <View style={[styles.searchBar, rowDir(isRTL)]}>
                <Ionicons name="search-outline" size={icon.row} color={colors.textSubtle} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t("groups.members.search")}
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel={t("groups.members.search")}
                  autoCorrect={false}
                  returnKeyType="search"
                  maxLength={200}
                  style={[styles.searchInput, textDir(isRTL)]}
                />
              </View>
              {rows.length === 0 ? (
                <Text style={[styles.hint, textDir(isRTL)]}>
                  {query.trim() ? t("customers.noResults") : t("groups.members.none")}
                </Text>
              ) : (
                rows.map((person) => {
                  const checked = member(person.id);
                  return (
                    <Pressable
                      key={person.id}
                      accessibilityRole={canManage ? "checkbox" : undefined}
                      accessibilityLabel={person.name}
                      accessibilityState={canManage ? { checked, disabled: busy } : undefined}
                      disabled={!canManage || busy}
                      onPress={() =>
                        setDesired((previous) => new Map(previous).set(person.id, !checked))
                      }
                      style={({ pressed }) => [
                        styles.row,
                        rowDir(isRTL),
                        pressed && { backgroundColor: colors.bgMuted },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.name, textDir(isRTL)]} numberOfLines={1}>
                          {person.name}
                        </Text>
                        {person.phone ? (
                          <Text
                            style={[
                              styles.phone,
                              { writingDirection: "ltr", textAlign: isRTL ? "right" : "left" },
                            ]}
                          >
                            {ltrIsolate(person.phone)}
                          </Text>
                        ) : null}
                      </View>
                      {canManage ? (
                        <Ionicons
                          name={checked ? "checkbox" : "square-outline"}
                          size={icon.row}
                          color={checked ? colors.actionPrimary : colors.textSubtle}
                        />
                      ) : null}
                    </Pressable>
                  );
                })
              )}
              {inScope && error ? (
                <Text style={[styles.error, textDir(isRTL)]}>{error}</Text>
              ) : null}
            </>
          )}
        </ScrollView>
        {canManage && group ? (
          <View style={styles.footer}>
            <Button
              label={t("common.done")}
              onPress={() => void save()}
              loading={busy}
              disabled={busy || people === null}
              fullWidth
            />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20, gap: 12 },
  hint: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.textSubtle, lineHeight: 21 },
  count: { fontFamily: fonts.sansMedium, fontSize: 13, color: colors.textDefault },
  searchBar: {
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sansRegular,
    fontSize: 15,
    color: colors.textDefault,
    paddingVertical: 10,
  },
  row: {
    minHeight: 52,
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  name: { fontFamily: fonts.sansRegular, fontSize: 15, color: colors.textDefault },
  phone: { fontFamily: fonts.monoRegular, fontSize: 12, color: colors.textSubtle, marginTop: 2 },
  error: { fontFamily: fonts.sansRegular, fontSize: 13, color: colors.danger },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
});
