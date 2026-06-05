import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PersonRow } from "../components/PersonRow";
import { Tabs } from "../components/Tabs";
import { useToast, useToastOffset } from "../components/Toast";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { ProfileMenuSheet } from "../components/ProfileMenuSheet";
import { getSessionUser } from "../lib/auth";
import { archivePerson, getLocalSelf, listAllPeople } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { t } from "../lib/i18n";
import type { Direction, PersonWithBalance, Self } from "../lib/types";

// Tab labels are computed at render time so locale changes (after a hot reload
// during dev) flow through. The keys remain stable identifiers.
function buildTabs() {
  return [
    { key: "collect" as const, label: t("home.tab.collect") },
    { key: "pay" as const, label: t("home.tab.pay") },
  ];
}

// Velocity (px/s) at or above which a "flick" commits the tab switch even with
// a small drag distance. Standard mobile UX values land around 400-600 px/s.
const FLICK_VELOCITY = 500;
// Drag distance (as a fraction of screen width) at or above which a slow drag
// commits even without a flick. 30% is the common iOS/Material convention.
const DRAG_COMMIT_FRACTION = 0.3;
// Spring config for both the gesture-end animation and the tab-tap animation.
// Mid-stiffness: fast settle without overshoot.
const RAIL_SPRING = { friction: 14, tension: 110 } as const;

export default function HomeScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { forceUpdate } = useAppMeta();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen (and all its children) without an app restart. Strings via
  // t() refresh on the same render.
  const isRTL = useIsRTL();

  const [self, setSelf] = useState<Self | null>(null);
  const [direction, setDirection] = useState<Direction>("collect");
  const [allPeople, setAllPeople] = useState<PersonWithBalance[]>([]);
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Profile menu state. sessionEmail is read on focus so it stays in
  // sync with sign-in/out actions taken on the Account screen.
  const [profileMenuVisible, setProfileMenuVisible] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Rail position: 0 = collect tab visible, -screenWidth = pay tab visible.
  // We use a non-native Animated.Value because the gesture's onUpdate calls
  // .setValue() per frame; transforms are still GPU-composited via useNativeDriver
  // on the consumer side.
  const translateX = useRef(new Animated.Value(0)).current;

  // Timestamp of the last hardware back press while home is focused. Lives
  // OUTSIDE the useFocusEffect callback so it persists across re-subscriptions —
  // pushing a toast re-renders the ToastProvider, which produces a new context
  // value object, which invalidates the [toast] dep of the focus effect's
  // useCallback. Without this ref pinned at the component level the timestamp
  // would reset to 0 on every back press and the second press would still see
  // "no recent press" and re-trigger the toast forever.
  const lastBackPressRef = useRef(0);

  const load = useCallback(async () => {
    const [s, list, user] = await Promise.all([getLocalSelf(), listAllPeople(), getSessionUser()]);
    setSelf(s);
    setAllPeople(list);
    setSessionEmail(user?.email ?? null);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Intercept the Android hardware back button on the home screen so a single
  // tap doesn't immediately close the app. Requires two presses within 2s —
  // a familiar "press back again to exit" pattern. Only active while home is
  // focused; other screens get normal back behavior (pop the stack).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        const now = Date.now();
        if (now - lastBackPressRef.current < 2000) {
          // Second press inside the window → let RN handle (exits the app).
          return false;
        }
        lastBackPressRef.current = now;
        toast.push(t("home.exit.hint"), "info");
        return true; // intercept
      });
      return () => sub.remove();
    }, [toast]),
  );

  // Filter + sort once per data change. Same rules as listPeople() used to
  // apply server-side: collect descending by balance, pay ascending (most
  // negative first), name as tie-breaker.
  const collectPeople = useMemo(
    () =>
      allPeople
        .filter((p) => p.balance >= 0)
        .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name)),
    [allPeople],
  );
  const payPeople = useMemo(
    () =>
      allPeople
        .filter((p) => p.balance < 0)
        .sort((a, b) => a.balance - b.balance || a.name.localeCompare(b.name)),
    [allPeople],
  );

  // Animate the rail to the resting position for the current direction.
  // Fires on both tab taps (direction changes via Tabs) and post-commit
  // direction changes from swipe. Cleanup stops any in-flight spring so
  // a rapid tap-then-swipe (or vice-versa) doesn't stall mid-screen.
  useEffect(() => {
    const target = direction === "collect" ? 0 : -screenWidth;
    const animation = Animated.spring(translateX, {
      toValue: target,
      useNativeDriver: true,
      ...RAIL_SPRING,
    });
    animation.start();
    return () => animation.stop();
  }, [direction, screenWidth, translateX]);

  // The swipe gesture. activeOffsetX requires ~24px of horizontal movement
  // before the pan claims the touch — keeps small vertical drags falling
  // through to the inner ScrollView. failOffsetY abandons the gesture entirely
  // if the user starts a clearly-vertical drag.
  const swipeGesture = useMemo(() => {
    const baseAt = (d: Direction) => (d === "collect" ? 0 : -screenWidth);
    return Gesture.Pan()
      .activeOffsetX([-24, 24])
      .failOffsetY([-16, 16])
      .runOnJS(true)
      .onUpdate((e) => {
        // Follow finger. Clamp to the rail's bounds so users can't drag
        // past the first/last tab into empty space.
        const next = baseAt(direction) + e.translationX;
        const clamped = Math.max(-screenWidth, Math.min(0, next));
        translateX.setValue(clamped);
      })
      .onEnd((e) => {
        const distance = e.translationX;
        const velocity = e.velocityX;
        // Velocity-aware commit: a flick beats a slow drag. Without a flick,
        // the user must have dragged at least DRAG_COMMIT_FRACTION of the
        // screen width in the right direction.
        const flickLeft = velocity <= -FLICK_VELOCITY;
        const flickRight = velocity >= FLICK_VELOCITY;
        const dragLeft = distance <= -screenWidth * DRAG_COMMIT_FRACTION;
        const dragRight = distance >= screenWidth * DRAG_COMMIT_FRACTION;

        const commitToPay = direction === "collect" && (dragLeft || flickLeft);
        const commitToCollect = direction === "pay" && (dragRight || flickRight);

        if (commitToPay) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
          setDirection("pay");
        } else if (commitToCollect) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
          setDirection("collect");
        } else {
          // Released below the threshold — spring back to the current tab's
          // resting position. The post-commit useEffect handles the other
          // case, so we only need this branch here.
          Animated.spring(translateX, {
            toValue: baseAt(direction),
            useNativeDriver: true,
            ...RAIL_SPRING,
          }).start();
        }
      });
  }, [direction, screenWidth, translateX]);

  if (forceUpdate) return <Redirect href="/update-prompt" />;
  if (loaded && !self) return <Redirect href="/onboarding" />;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.header, rowDir(isRTL)]}>
        {/* Start edge: wordmark on top, store/personal name below.
            Identity text is informational only — settings + account live
            behind the profile icon on the opposite end. */}
        <View style={styles.headerStart}>
          <Text style={[styles.wordmark, textDir(isRTL)]}>{t("brand.wordmark")}</Text>
          {self ? (
            <Text style={[styles.identity, textDir(isRTL)]} numberOfLines={1}>
              {self.shop_name ?? self.name}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => setProfileMenuVisible(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.headerSettingsBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons
            name={sessionEmail ? "person-circle" : "person-circle-outline"}
            size={26}
            color={colors.textSubtle}
          />
        </Pressable>
      </View>

      <UpdateBanner />

      <View style={styles.tabsWrap}>
        <Tabs<Direction> tabs={buildTabs()} value={direction} onChange={setDirection} />
      </View>

      <GestureDetector gesture={swipeGesture}>
        <Animated.View
          style={[styles.rail, { width: screenWidth * 2, transform: [{ translateX }] }]}
        >
          <TabPage
            direction="collect"
            people={collectPeople}
            width={screenWidth}
            paddingBottom={96 + insets.bottom}
            onPersonPress={(id) => router.push({ pathname: "/person/[id]", params: { id } })}
            onPersonLongPress={setSheetFor}
          />
          <TabPage
            direction="pay"
            people={payPeople}
            width={screenWidth}
            paddingBottom={96 + insets.bottom}
            onPersonPress={(id) => router.push({ pathname: "/person/[id]", params: { id } })}
            onPersonLongPress={setSheetFor}
          />
        </Animated.View>
      </GestureDetector>

      {/*
       * INVARIANT: + FAB on the RIGHT side. Same right-hand-is-giving
       * cultural rule as the give/receive row in person/[id]. The
       * absolute `right: 20` works only because _layout.tsx neutralizes
       * I18nManager (allowRTL(false) + swapLeftAndRightInRTL(false))
       * and ensures the Activity is LTR via the one-shot migration
       * prompt. If the Activity were RTL, RN would silently reinterpret
       * `right` as `left` (the v0.2.4 bug).
       */}
      <Animated.View
        style={[
          styles.fab,
          { bottom: 20 + insets.bottom, transform: [{ translateY: toastOffset }] },
        ]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => router.push("/person/new")}
          style={({ pressed }) => [styles.fabInner, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={26} color={colors.textInverted} />
        </Pressable>
      </Animated.View>

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor?.name}
        onDismiss={() => setSheetFor(null)}
        actions={[
          {
            label: t("person.sheet.edit"),
            icon: "create-outline",
            onPress: () => {
              const id = sheetFor?.id;
              if (id) router.push({ pathname: "/person/[id]/edit", params: { id } });
            },
          },
          {
            label: t("common.remove"),
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={t("common.remove.title", { name: confirmDeleteFor?.name ?? "" })}
        description={t("common.remove.description")}
        confirmLabel={t("common.remove")}
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            const name = confirmDeleteFor.name;
            await archivePerson(confirmDeleteFor.id);
            await load();
            toast.push(t("common.removed", { name }), "success");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />

      <ProfileMenuSheet
        visible={profileMenuVisible}
        signedInEmail={sessionEmail}
        onAccount={() => router.push("/account")}
        onPreferences={() => router.push("/preferences")}
        onDismiss={() => setProfileMenuVisible(false)}
      />
    </SafeAreaView>
  );
}

function TabPage(props: {
  direction: Direction;
  people: PersonWithBalance[];
  width: number;
  paddingBottom: number;
  onPersonPress: (id: string) => void;
  onPersonLongPress: (person: PersonWithBalance) => void;
}) {
  const isRTL = useIsRTL();
  const total = props.people.reduce((sum, p) => sum + Math.abs(p.balance), 0);
  const active = props.people.filter((p) => p.balance !== 0).length;
  const totalLabel =
    props.direction === "collect" ? t("home.total.label.collect") : t("home.total.label.pay");

  return (
    <View style={{ width: props.width }}>
      <ScrollView contentContainerStyle={{ paddingBottom: props.paddingBottom }}>
        <View style={styles.totalBlock}>
          <Text style={[styles.totalLabel, textDir(isRTL)]}>{totalLabel}</Text>
          <View style={[styles.totalRow, rowDir(isRTL)]}>
            <Text style={styles.totalAmount}>{formatAmount(total)}</Text>
            <Text style={styles.totalAfn}>{getCurrentCurrencySymbol()}</Text>
          </View>
          <Text style={[styles.totalSub, textDir(isRTL)]}>
            {active === 0
              ? props.people.length === 0
                ? t("home.empty.noOneYet")
                : t("home.empty.allSettled")
              : t(active === 1 ? "home.from.someone" : "home.from.many", { count: active })}
          </Text>
        </View>

        {props.people.length === 0 ? (
          <EmptyState
            title={
              props.direction === "collect"
                ? t("home.empty.collect.title")
                : t("home.empty.pay.title")
            }
            subtitle={
              props.direction === "collect"
                ? t("home.empty.collect.subtitle")
                : t("home.empty.pay.subtitle")
            }
          />
        ) : (
          <View style={styles.list}>
            {props.people.map((p, i) => (
              <View key={p.id}>
                <PersonRow
                  person={p}
                  onPress={() => props.onPersonPress(p.id)}
                  onLongPress={() => props.onPersonLongPress(p)}
                />
                {i < props.people.length - 1 ? <View style={styles.divider} /> : null}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  headerStart: {
    // Stacks wordmark on top of identity. Sits on the script's start edge
    // because the parent header uses rowDir(isRTL) to swap children.
    flex: 1,
  },
  headerSettingsBtn: {
    // Bumps to sit roughly on the wordmark baseline. Hit area is the
    // 22px icon + 8px hitSlop, so comfortable to tap.
    paddingTop: 4,
  },
  wordmark: {
    fontSize: 24,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  identity: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
  tabsWrap: { paddingHorizontal: 16, marginBottom: 16 },
  rail: {
    flex: 1,
    // Keep collect-tab on the physical left, pay-tab on the physical right.
    // The swipe gesture's translateX math assumes this layout (translateX 0
    // = collect visible, translateX -screenWidth = pay visible). Yoga
    // WOULD auto-reverse `flexDirection: 'row'` children if the Activity
    // were RTL, breaking the gesture. We avoid that by ensuring the
    // Activity is LTR via _layout.tsx's I18nManager neutralization + the
    // one-shot migration prompt — see that file for the full architecture.
    flexDirection: "row",
  },
  totalBlock: { paddingHorizontal: 16, marginBottom: 20 },
  totalLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  totalRow: { flexDirection: "row", alignItems: "baseline", marginTop: 6, gap: 6 },
  totalAmount: {
    fontSize: 36,
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  totalAfn: { fontSize: 14, fontFamily: fonts.sansMedium, color: colors.textMuted },
  totalSub: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  fab: {
    position: "absolute",
    // INVARIANT: + FAB stays on the physical RIGHT regardless of script.
    // Relies on the Activity being LTR — _layout.tsx neutralizes
    // I18nManager (allowRTL(false) + swapLeftAndRightInRTL(false) + a
    // one-shot forceRTL(false) migration). Once that's persisted, every
    // future Activity comes up LTR and `right: 20` means physical right.
    // (If the Activity is RTL, RN's auto-swap would silently reinterpret
    // `right` as `left`. The migration prompt in _layout.tsx prevents that
    // case from ever rendering this view.)
    right: 20,
    width: 52,
    height: 52,
  },
  fabInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.bgInverted,
    alignItems: "center",
    justifyContent: "center",
  },
});
