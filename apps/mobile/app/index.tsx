import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
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
import { archivePerson, getLocalSelf, listAllPeople } from "../lib/db";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import type { Direction, PersonWithBalance, Self } from "../lib/types";

const TABS = [
  { key: "collect", label: "To collect" },
  { key: "pay", label: "To pay" },
] as const;

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

  const [self, setSelf] = useState<Self | null>(null);
  const [direction, setDirection] = useState<Direction>("collect");
  const [allPeople, setAllPeople] = useState<PersonWithBalance[]>([]);
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Rail position: 0 = collect tab visible, -screenWidth = pay tab visible.
  // We use a non-native Animated.Value because the gesture's onUpdate calls
  // .setValue() per frame; transforms are still GPU-composited via useNativeDriver
  // on the consumer side.
  const translateX = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([getLocalSelf(), listAllPeople()]);
    setSelf(s);
    setAllPeople(list);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
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
      <View style={styles.header}>
        <Text style={styles.wordmark}>kaata.</Text>
        {self ? (
          <Pressable
            onPress={() => router.push("/settings")}
            hitSlop={8}
            style={({ pressed }) => [styles.identityRow, pressed && { opacity: 0.5 }]}
          >
            <Text style={styles.identity} numberOfLines={1}>
              {self.shop_name ?? self.name}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <UpdateBanner />

      <View style={styles.tabsWrap}>
        <Tabs<Direction> tabs={TABS} value={direction} onChange={setDirection} />
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
            label: "Edit",
            icon: "create-outline",
            onPress: () => {
              const id = sheetFor?.id;
              if (id) router.push({ pathname: "/person/[id]/edit", params: { id } });
            },
          },
          {
            label: "Remove",
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={`Remove ${confirmDeleteFor?.name ?? ""}?`}
        description="They'll disappear from your list. Their entries stay on your device."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            const name = confirmDeleteFor.name;
            await archivePerson(confirmDeleteFor.id);
            await load();
            toast.push(`${name} removed`, "success");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
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
  const total = props.people.reduce((sum, p) => sum + Math.abs(p.balance), 0);
  const active = props.people.filter((p) => p.balance !== 0).length;
  const totalLabel = props.direction === "collect" ? "To collect" : "To pay";

  return (
    <View style={{ width: props.width }}>
      <ScrollView contentContainerStyle={{ paddingBottom: props.paddingBottom }}>
        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>{totalLabel}</Text>
          <View style={styles.totalRow}>
            <Text style={styles.totalAmount}>{formatAmount(total)}</Text>
            <Text style={styles.totalAfn}>AFN</Text>
          </View>
          <Text style={styles.totalSub}>
            {active === 0
              ? props.people.length === 0
                ? "no one here yet"
                : "everyone settled"
              : `from ${active} ${active === 1 ? "person" : "people"}`}
          </Text>
        </View>

        {props.people.length === 0 ? (
          <EmptyState
            title={props.direction === "collect" ? "Nothing to collect yet" : "You owe no one yet"}
            subtitle={
              props.direction === "collect"
                ? "Tap the + button to add someone you keep accounts with."
                : "When you take goods or borrow money, log it from that person's page and they'll appear here."
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
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  wordmark: {
    fontSize: 24,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
    alignSelf: "flex-start",
  },
  identity: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
  tabsWrap: { paddingHorizontal: 16, marginBottom: 16 },
  rail: { flex: 1, flexDirection: "row" },
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
