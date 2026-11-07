import { useIsFocused, useRouter } from "expo-router";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { InitialAvatar } from "../../components/InitialAvatar";
import { ScreenHeader } from "../../components/SettingsScreen";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "../../lib/db-tx";
import { SETTINGS_ROW_PADDING_X } from "../../lib/design-tokens";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../../lib/direction";
import { listFriends } from "../../lib/friends-api";
import { t } from "../../lib/i18n";
import type { DiscoveredPerson } from "../../lib/people-search";
import { TOUCH_MIN, typography } from "../../lib/tokens";

type FriendsView = {
  scope: string;
  rows: DiscoveredPerson[];
  cursor?: string;
  session: SessionSnapshot;
};

/** A list inside account settings; finding new people stays in the existing search. */
export default function FriendsScreen() {
  const router = useRouter();
  const rtl = useIsRTL();
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const network = Network.useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const revision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        revision.current++;
        notify();
      }),
    [],
  );
  const identitySnapshot = useCallback(
    () => `${revision.current}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribe, identitySnapshot, identitySnapshot);
  const account = getSessionAccountIdSync();
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([identity, focused, offline, attempt]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const mounted = useRef(true);
  const [stored, setStored] = useState<FriendsView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const loadingMore = useRef(false);
  const view = stored?.scope === scope ? stored : null;
  const current = () =>
    mounted.current &&
    focusedRef.current &&
    latestScope.current === scope &&
    identitySnapshot() === identity;
  const failed = failure === scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    if (!account || !focused || offline) return;
    void (async () => {
      const session = await captureCurrentSession();
      if (!alive || !current()) return;
      const result = await listFriends(undefined, session);
      await applyForCurrentSession(session, async () => {
        if (alive && current())
          setStored({ scope, rows: result.friends, cursor: result.next_cursor, session });
      });
    })().catch((error) => {
      if (!alive || !current()) return;
      setFailure(scope);
    });
    return () => {
      alive = false;
    };
  }, [scope]);
  async function more() {
    if (!view?.cursor || loadingMore.current || !current() || offline) return;
    loadingMore.current = true;
    setMoreBusy(true);
    setFailure(null);
    try {
      const result = await listFriends(view.cursor, view.session);
      await applyForCurrentSession(view.session, async () => {
        if (!current()) return;
        const seen = new Set(view.rows.map((person) => person.account_id));
        setStored({
          ...view,
          rows: [...view.rows, ...result.friends.filter((person) => !seen.has(person.account_id))],
          cursor: result.next_cursor,
        });
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SessionChangedError) setStored(null);
      setFailure(scope);
    } finally {
      loadingMore.current = false;
      if (mounted.current) setMoreBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("friends.title")}
        isRTL={rtl}
        onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {!account ? (
          <View style={styles.message}>
            <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.signIn")}</Text>
            <Button
              label={t("peopleProfile.signInAction")}
              onPress={() => router.push("/sign-in")}
            />
          </View>
        ) : offline ? (
          <Text style={[styles.message, styles.hint, textDir(rtl)]}>
            {t("peopleProfile.offline")}
          </Text>
        ) : !view && !failed ? (
          <View style={styles.message}>
            <ActivityIndicator color={colors.textSubtle} />
            <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.loading")}</Text>
          </View>
        ) : (
          <>
            <Text style={[styles.message, styles.hint, textDir(rtl)]}>{t("friends.hint")}</Text>
            {view?.rows.map((person) => (
              <Pressable
                key={person.account_id}
                accessibilityRole="button"
                accessibilityLabel={`${person.name}, ${t("peopleProfile.view")}`}
                onPress={() => {
                  if (current())
                    router.push({
                      pathname: "/people/[accountId]",
                      params: { accountId: person.account_id },
                    });
                }}
                style={[styles.row, rowDir(rtl)]}
              >
                <InitialAvatar size={44} label={Array.from(person.name)[0]?.toUpperCase() ?? ""} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, textDir(rtl)]}>{person.name}</Text>
                  {person.username ? (
                    <Text style={[styles.hint, textDir(rtl)]}>
                      {ltrIsolate(`@${person.username}`)}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
            {view && view.rows.length === 0 ? (
              <View style={styles.message}>
                <Text style={[styles.name, textDir(rtl)]}>{t("friends.empty")}</Text>
                <Text style={[styles.hint, textDir(rtl)]}>{t("friends.emptyHint")}</Text>
              </View>
            ) : null}
            {failed ? (
              <View style={styles.message}>
                <Text style={[styles.error, textDir(rtl)]} accessibilityRole="alert">
                  {t("friends.failed")}
                </Text>
                <Button
                  label={t("peopleProfile.retry")}
                  variant="secondary"
                  onPress={() => {
                    if (current()) {
                      if (view?.cursor) void more();
                      else setAttempt((value) => value + 1);
                    }
                  }}
                />
              </View>
            ) : view?.cursor ? (
              <View style={styles.message}>
                <Button
                  label={t("friends.more")}
                  variant="secondary"
                  loading={moreBusy}
                  onPress={() => void more()}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  content: { paddingBottom: 32 },
  message: { padding: SETTINGS_ROW_PADDING_X, gap: 12 },
  row: {
    minHeight: TOUCH_MIN,
    padding: SETTINGS_ROW_PADDING_X,
    alignItems: "center",
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  name: { ...typography.labelBold, color: colors.textEmphasis },
  hint: { ...typography.bodySm, color: colors.textSubtle },
  error: { ...typography.bodySm, color: colors.danger },
});
