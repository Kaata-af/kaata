import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { InitialAvatar } from "../../components/InitialAvatar";
import { PeopleProfileActions } from "../../components/PeopleProfileActions";
import { PeopleScreen } from "../../components/PeopleScreen";
import { NavRow, ScreenHeader, SectionGap } from "../../components/SettingsScreen";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "../../lib/db-tx";
import { SETTINGS_ROW_PADDING_X } from "../../lib/design-tokens";
import { ltrIsolate, textDir, useIsRTL } from "../../lib/direction";
import {
  acceptFriendRequest,
  dismissFriendRequest,
  getPersonProfile,
  removeFriend,
  sendFriendRequest,
  type PersonProfile,
} from "../../lib/friends-api";
import { t } from "../../lib/i18n";
import { typography } from "../../lib/tokens";
import { TabApiError } from "../../lib/tabs/errors";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const AVATAR_SIZE = 88;
type ProfileView = {
  scope: string;
  data?: PersonProfile;
  session?: SessionSnapshot;
  error?: "failed" | "unavailable";
};
type Action = "send" | "accept" | "dismiss" | "remove";

/** Public account identity, separate from the current book's financial person. */
export default function PeopleProfileScreen() {
  const router = useRouter();
  const { accountId: param } = useLocalSearchParams<{ accountId: string }>();
  const accountId = typeof param === "string" && UUID.test(param) ? param : null;
  const rtl = useIsRTL();
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const network = Network.useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const identityRevision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        identityRevision.current++;
        notify();
      }),
    [],
  );
  const identitySnapshot = useCallback(
    () => `${identityRevision.current}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribe, identitySnapshot, identitySnapshot);
  const viewer = getSessionAccountIdSync();
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([accountId, identity, focused, offline, attempt]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const mounted = useRef(true);
  const [stored, setStored] = useState<ProfileView | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef(false);
  const busyScope = useRef<string | null>(null);
  const profileRead = useRef(0);
  const [failureScope, setFailureScope] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    scope: string;
    key: "peopleProfile.cooldown" | "peopleProfile.requestLimit";
  } | null>(null);
  const [removeScope, setRemoveScope] = useState<string | null>(null);
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const current = () =>
    mounted.current &&
    focusedRef.current &&
    latestScope.current === scope &&
    identitySnapshot() === identity;
  const assertCurrent = () => {
    if (!current()) throw new SessionChangedError();
  };
  const view = stored?.scope === scope ? stored : null;
  const profile = view?.data;
  const actionFailed = failureScope === scope;
  const own = !!accountId && accountId === viewer;
  const refresh = () => {
    if (current() && !busyRef.current) setAttempt((value) => value + 1);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let running = false;
    if (!focused || offline || !viewer || !accountId) return;
    setStored({ scope });
    const mutating = () => busyRef.current && busyScope.current === scope;
    const load = async () => {
      if (!alive || !current() || running || mutating() || AppState.currentState !== "active")
        return;
      running = true;
      const request = ++profileRead.current;
      const stillCurrent = () =>
        alive && current() && !mutating() && request === profileRead.current;
      try {
        const session = await captureCurrentSession();
        if (!stillCurrent()) return;
        const data = await getPersonProfile(accountId, session, undefined, () => {
          if (!stillCurrent()) throw new SessionChangedError();
        });
        await applyForCurrentSession(session, async () => {
          if (!stillCurrent()) return;
          setStored({ scope, data, session });
          if (data.friendship.state !== "friends") setRemoveScope(null);
        });
      } catch (error) {
        if (!stillCurrent()) return;
        const accessChanged =
          error instanceof SessionChangedError ||
          (error instanceof TabApiError && [401, 403, 404].includes(error.status));
        setStored((previous) => {
          // A transient poll failure must not replace a usable profile with a
          // spinner/error. A refused profile, however, is no longer ours to show.
          if (!accessChanged && previous?.scope === scope && previous.data) return previous;
          return {
            scope,
            error: error instanceof TabApiError && error.status === 404 ? "unavailable" : "failed",
          };
        });
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      app.remove();
    };
  }, [scope]);

  async function act(action: Action) {
    const loaded = view;
    if (
      !loaded?.data ||
      !loaded.session ||
      !accountId ||
      own ||
      offline ||
      actionFailed ||
      busyRef.current ||
      !current()
    )
      return;
    const friendship = loaded.data.friendship;
    if (
      (action === "send" && friendship.state !== "none") ||
      (action === "accept" && friendship.state !== "incoming") ||
      (action === "dismiss" &&
        friendship.state !== "incoming" &&
        friendship.state !== "outgoing") ||
      (action === "remove" && friendship.state !== "friends") ||
      (action !== "send" && !friendship.id)
    )
      return;
    busyRef.current = true;
    busyScope.current = scope;
    ++profileRead.current;
    setBusy(action);
    setActionNotice(null);
    setRemoveScope(null);
    try {
      await applyForCurrentSession(loaded.session, async () => {});
      if (!current()) return;
      const next =
        action === "send"
          ? await sendFriendRequest(accountId, loaded.session, assertCurrent)
          : action === "accept"
            ? await acceptFriendRequest(friendship.id!, loaded.session, assertCurrent)
            : action === "dismiss"
              ? (await dismissFriendRequest(friendship.id!, loaded.session, assertCurrent),
                { state: "none" as const })
              : (await removeFriend(friendship.id!, loaded.session, assertCurrent),
                { state: "none" as const });
      await applyForCurrentSession(loaded.session, async () => {
        if (!current()) return;
        // Removing/dismissing the relationship can revoke profile visibility.
        // Fetch again before retaining or presenting those account details.
        if (action === "remove" || action === "dismiss") setAttempt((value) => value + 1);
        else setStored({ ...loaded, data: { ...loaded.data!, friendship: next } });
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SessionChangedError) setStored({ scope, error: "failed" });
      else if (
        error instanceof TabApiError &&
        error.status === 429 &&
        (error.code === "friend_request_cooldown" || error.code === "friend_request_limit")
      )
        setActionNotice({
          scope,
          key:
            error.code === "friend_request_cooldown"
              ? "peopleProfile.cooldown"
              : "peopleProfile.requestLimit",
        });
      else setFailureScope(scope);
    } finally {
      busyRef.current = false;
      busyScope.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  const disabled = !!busy || offline || actionFailed;
  return (
    <PeopleScreen>
      <ScreenHeader
        title={t("peopleProfile.title")}
        isRTL={rtl}
        onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {!viewer ? (
          <View style={styles.message}>
            <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.signIn")}</Text>
            <Button
              label={t("peopleProfile.signInAction")}
              onPress={() => {
                if (!current()) return;
                router.push(
                  accountId
                    ? { pathname: "/sign-in", params: { profileAccountId: accountId } }
                    : "/sign-in",
                );
              }}
            />
          </View>
        ) : !accountId || view?.error === "unavailable" ? (
          <Text style={[styles.message, styles.hint, textDir(rtl)]}>
            {t("peopleProfile.unavailable")}
          </Text>
        ) : offline ? (
          <Text style={[styles.message, styles.hint, textDir(rtl)]}>
            {t("peopleProfile.offline")}
          </Text>
        ) : view?.error ? (
          <View style={styles.message}>
            <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.failed")}</Text>
            <Button label={t("peopleProfile.retry")} onPress={refresh} variant="secondary" />
          </View>
        ) : !profile || !view?.session ? (
          <View style={styles.message} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.textSubtle} />
            <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.loading")}</Text>
          </View>
        ) : (
          <>
            <View style={styles.identity}>
              {profile.person.picture_url &&
              /^https:\/\//i.test(profile.person.picture_url) &&
              failedPhoto !== profile.person.picture_url ? (
                <Image
                  source={{ uri: profile.person.picture_url }}
                  style={styles.avatar}
                  onError={() => setFailedPhoto(profile.person.picture_url!)}
                />
              ) : (
                <InitialAvatar
                  size={AVATAR_SIZE}
                  label={Array.from(profile.person.name)[0]?.toUpperCase() ?? ""}
                />
              )}
              <Text style={[styles.name, textDir(rtl)]}>{profile.person.name}</Text>
              {profile.person.username ? (
                <Text style={[styles.hint, textDir(rtl)]}>
                  {ltrIsolate(`@${profile.person.username}`)}
                </Text>
              ) : null}
            </View>
            {own ? (
              <NavRow
                icon="person-circle-outline"
                label={t("peopleProfile.ownAccount")}
                hint={t("peopleProfile.own")}
                onPress={() => router.push("/account")}
                isRTL={rtl}
                isLast
              />
            ) : (
              <>
                <View style={styles.friendship}>
                  {profile.friendship.state === "none" ? (
                    <Button
                      label={t("peopleProfile.addFriend")}
                      icon="person-add-outline"
                      disabled={disabled}
                      loading={busy === "send"}
                      onPress={() => void act("send")}
                      fullWidth
                    />
                  ) : null}
                  {profile.friendship.state === "incoming" ? (
                    <>
                      <Text style={[styles.status, textDir(rtl)]}>
                        {t("peopleProfile.incoming", { name: profile.person.name })}
                      </Text>
                      <Button
                        label={t("peopleProfile.accept")}
                        disabled={disabled}
                        loading={busy === "accept"}
                        onPress={() => void act("accept")}
                        fullWidth
                      />
                      <Button
                        label={t("peopleProfile.decline")}
                        variant="secondary"
                        disabled={disabled}
                        loading={busy === "dismiss"}
                        onPress={() => void act("dismiss")}
                        fullWidth
                      />
                    </>
                  ) : null}
                  {profile.friendship.state === "outgoing" ? (
                    <>
                      <Text style={[styles.status, textDir(rtl)]} accessibilityLiveRegion="polite">
                        {t("peopleProfile.outgoing")}
                      </Text>
                      <Button
                        label={t("peopleProfile.cancel")}
                        variant="secondary"
                        disabled={disabled}
                        loading={busy === "dismiss"}
                        onPress={() => void act("dismiss")}
                        fullWidth
                      />
                    </>
                  ) : null}
                  {profile.friendship.state === "friends" ? (
                    <>
                      <Text style={[styles.status, textDir(rtl)]} accessibilityLiveRegion="polite">
                        {t("peopleProfile.friends")}
                      </Text>
                      <Button
                        label={t("peopleProfile.remove")}
                        variant="secondary"
                        disabled={disabled}
                        loading={busy === "remove"}
                        onPress={() => {
                          if (current() && !busyRef.current) setRemoveScope(scope);
                        }}
                        fullWidth
                      />
                    </>
                  ) : null}
                  <Text style={[styles.hint, textDir(rtl)]}>{t("peopleProfile.friendHint")}</Text>
                  {actionNotice?.scope === scope ? (
                    <Text style={[styles.error, textDir(rtl)]} accessibilityRole="alert">
                      {t(actionNotice.key)}
                    </Text>
                  ) : null}
                  {actionFailed ? (
                    <>
                      <Text style={[styles.error, textDir(rtl)]} accessibilityRole="alert">
                        {t("peopleProfile.actionFailed")}
                      </Text>
                      <Button
                        label={t("peopleProfile.refresh")}
                        variant="secondary"
                        onPress={refresh}
                      />
                    </>
                  ) : null}
                </View>
                <SectionGap />
                <PeopleProfileActions
                  person={profile.person}
                  session={view.session}
                  isCurrent={current}
                  disabled={!!busy}
                  onChanged={refresh}
                  onOpenLedger={(personId) => {
                    if (current())
                      router.dismissTo({ pathname: "/person/[id]", params: { id: personId } });
                  }}
                />
              </>
            )}
          </>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={!!profile && removeScope === scope}
        title={t("peopleProfile.removeTitle")}
        description={t("peopleProfile.removeBody", { name: profile?.person.name ?? "" })}
        destructive
        confirmLabel={t("peopleProfile.remove")}
        onConfirm={() => void act("remove")}
        onCancel={() => setRemoveScope(null)}
      />
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  message: { padding: SETTINGS_ROW_PADDING_X, gap: 16 },
  identity: { alignItems: "center", padding: SETTINGS_ROW_PADDING_X, paddingTop: 28, gap: 10 },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
  },
  name: { ...typography.heading, color: colors.textEmphasis, textAlign: "center" },
  friendship: { paddingHorizontal: SETTINGS_ROW_PADDING_X, paddingVertical: 12, gap: 12 },
  status: { ...typography.labelBold, color: colors.textEmphasis },
  hint: { ...typography.bodySm, color: colors.textSubtle },
  error: { ...typography.bodySm, color: colors.danger },
});
