import { Ionicons } from "@expo/vector-icons";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PersonRow } from "../components/PersonRow";
import { Tabs } from "../components/Tabs";
import { useToast } from "../components/Toast";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { archivePerson, getLocalSelf, listPeople } from "../lib/db";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import type { Direction, PersonWithBalance, Self } from "../lib/types";

const TABS = [
  { key: "collect", label: "To collect" },
  { key: "pay", label: "To pay" },
] as const;

export default function HomeScreen() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { forceUpdate } = useAppMeta();
  const [self, setSelf] = useState<Self | null>(null);
  const [direction, setDirection] = useState<Direction>("collect");
  const [people, setPeople] = useState<PersonWithBalance[]>([]);
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([getLocalSelf(), listPeople(direction)]);
    setSelf(s);
    setPeople(list);
    setLoaded(true);
  }, [direction]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Horizontal pan switches tabs. activeOffsetX guards against accidental
  // tab switches on near-vertical drags (the scroll list dominates); failOffsetY
  // lets clearly-vertical gestures fall through to the ScrollView cleanly.
  const swipeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-24, 24])
        .failOffsetY([-16, 16])
        .runOnJS(true)
        .onEnd((e) => {
          if (e.translationX < -50) setDirection("pay");
          else if (e.translationX > 50) setDirection("collect");
        }),
    [],
  );

  if (forceUpdate) return <Redirect href="/update-prompt" />;
  if (loaded && !self) return <Redirect href="/onboarding" />;

  // Sum of absolute balances among the active set in this tab.
  const total = people.reduce((sum, p) => sum + Math.abs(p.balance), 0);
  const active = people.filter((p) => p.balance !== 0).length;
  const totalLabel = direction === "collect" ? "To collect" : "To pay";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <GestureDetector gesture={swipeGesture}>
        <ScrollView contentContainerStyle={{ paddingBottom: 96 + insets.bottom }}>
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

          <View style={styles.totalBlock}>
            <Text style={styles.totalLabel}>{totalLabel}</Text>
            <View style={styles.totalRow}>
              <Text style={styles.totalAmount}>{formatAmount(total)}</Text>
              <Text style={styles.totalAfn}>AFN</Text>
            </View>
            <Text style={styles.totalSub}>
              {active === 0
                ? people.length === 0
                  ? "no one here yet"
                  : "everyone settled"
                : `from ${active} ${active === 1 ? "person" : "people"}`}
            </Text>
          </View>

          {people.length === 0 ? (
            <EmptyState
              title={direction === "collect" ? "Nothing to collect yet" : "You owe no one yet"}
              subtitle={
                direction === "collect"
                  ? "Tap the + button to add someone you keep accounts with."
                  : "When you take goods or borrow money, log it from that person's page and they'll appear here."
              }
            />
          ) : (
            <View style={styles.list}>
              {people.map((p, i) => (
                <View key={p.id}>
                  <PersonRow
                    person={p}
                    onPress={() => router.push({ pathname: "/person/[id]", params: { id: p.id } })}
                    onLongPress={() => setSheetFor(p)}
                  />
                  {i < people.length - 1 ? <View style={styles.divider} /> : null}
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </GestureDetector>

      <Pressable
        onPress={() => router.push("/person/new")}
        style={({ pressed }) => [
          styles.fab,
          { bottom: 20 + insets.bottom, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Ionicons name="add" size={26} color={colors.textInverted} />
      </Pressable>

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
    borderRadius: 26,
    backgroundColor: colors.bgInverted,
    alignItems: "center",
    justifyContent: "center",
  },
});
