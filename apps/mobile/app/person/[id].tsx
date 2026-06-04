import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../../components/BottomSheet";
import { Chip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { EntryRow } from "../../components/EntryRow";
import { useToast, useToastOffset } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { getLocalSelf, getPerson, listEntries, softDeleteEntry } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { shareKaataViaWhatsApp } from "../../lib/share";
import type { Entry, PersonWithBalance, Self } from "../../lib/types";

export default function PersonDetailScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen and all its descendants, so strings via t() refresh too.
  const isRTL = useIsRTL();

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const [p, list, s] = await Promise.all([getPerson(id), listEntries(id), getLocalSelf()]);
    setPerson(p);
    setEntries(list);
    setSelf(s);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!person) {
    return (
      <SafeAreaView style={styles.container}>
        <View />
      </SafeAreaView>
    );
  }

  const abs = Math.abs(person.balance);
  // Direction is derived from the running net — not from any URL param or
  // person-level property. balance > 0 → they owe me; balance < 0 → I owe them.
  const hasBalance = person.balance !== 0;
  const chipLabel =
    person.balance > 0
      ? t("person.balance.theyOwe")
      : person.balance < 0
        ? t("person.balance.youOwe")
        : null;
  const chipVariant: "collect" | "pay" | null =
    person.balance > 0 ? "collect" : person.balance < 0 ? "pay" : null;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.headerNav, rowDir(isRTL)]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={22}
            color={colors.textEmphasis}
          />
        </Pressable>
        <Pressable
          onPress={() => router.push({ pathname: "/person/[id]/edit", params: { id: person.id } })}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="create-outline" size={20} color={colors.textEmphasis} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: (entries.length > 0 ? 96 : 24) + insets.bottom,
        }}
      >
        <View style={styles.info}>
          <Text style={[styles.name, textDir(isRTL)]}>{person.name}</Text>
          {person.phone ? <Text style={[styles.phone, textDir(isRTL)]}>{person.phone}</Text> : null}
          <View style={{ height: 16 }} />
          {chipLabel && chipVariant ? (
            <Chip label={chipLabel} variant={chipVariant} />
          ) : entries.length > 0 ? (
            <Chip label={t("person.balance.settled")} variant="neutral" />
          ) : null}
          <View style={[styles.balanceRow, rowDir(isRTL)]}>
            <Text style={[styles.balance, !hasBalance && { color: colors.textMuted }]}>
              {formatAmount(abs)}
            </Text>
            <Text style={styles.balanceAfn}>{getCurrentCurrencySymbol()}</Text>
          </View>
        </View>

        {/*
         * INVARIANT: "I gave" on the RIGHT, "I received" on the LEFT.
         * Right-hand-is-giving cultural rule. The actions style below uses
         * `flexDirection: "row"` and relies on the Activity being LTR —
         * that's guaranteed by _layout.tsx's I18nManager neutralization +
         * one-shot migration prompt. If the Activity were RTL, Yoga would
         * auto-reverse children and "I gave" would land on the left
         * (the v0.2.4 bug).
         */}
        <View style={styles.actions}>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/entry/new",
                params: { personId: person.id, type: "payment" },
              })
            }
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { backgroundColor: colors.bgMuted },
            ]}
          >
            <Ionicons name="arrow-down-outline" size={16} color={colors.textEmphasis} />
            <Text style={styles.actionText}>{t("person.action.iReceived")}</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/entry/new",
                params: { personId: person.id, type: "debt" },
              })
            }
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { backgroundColor: colors.bgMuted },
            ]}
          >
            <Ionicons name="arrow-up-outline" size={16} color={colors.textEmphasis} />
            <Text style={styles.actionText}>{t("person.action.iGave")}</Text>
          </Pressable>
        </View>

        {entries.length === 0 ? (
          <EmptyState title={t("person.empty.title")} subtitle={t("person.empty.subtitle")} />
        ) : (
          <View style={styles.list}>
            {entries.map((e, i) => (
              <View key={e.id}>
                <EntryRow entry={e} onPress={() => setSheetFor(e)} />
                {i < entries.length - 1 ? <View style={styles.divider} /> : null}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {entries.length > 0 ? (
        <Animated.View
          style={[
            styles.pingBar,
            { paddingBottom: 20 + insets.bottom, transform: [{ translateY: toastOffset }] },
          ]}
        >
          <Pressable
            onPress={() =>
              shareKaataViaWhatsApp(
                { name: person.name, phone: person.phone },
                person.balance,
                self,
              )
            }
            style={({ pressed }) => [styles.pingButton, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="logo-whatsapp" size={20} color={colors.textInverted} />
            <Text style={styles.pingButtonLabel} numberOfLines={1}>
              {t("person.ping", { name: person.name })}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor ? `${formatAmount(sheetFor.amount_afn)} AFN` : undefined}
        onDismiss={() => setSheetFor(null)}
        actions={[
          {
            label: t("person.sheet.edit"),
            icon: "create-outline",
            onPress: () => {
              const eid = sheetFor?.id;
              if (eid) router.push({ pathname: "/entry/[id]/edit", params: { id: eid } });
            },
          },
          {
            label: t("person.sheet.delete"),
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={t("person.delete.title")}
        description={t("person.delete.description")}
        confirmLabel={t("person.delete.confirm")}
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            await softDeleteEntry(confirmDeleteFor.id);
            await load();
            toast.push(t("entry.deleted"), "success");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  headerNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  name: { fontSize: 22, fontFamily: fonts.sansBold, color: colors.textEmphasis },
  phone: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  balanceRow: { flexDirection: "row", alignItems: "baseline", marginTop: 10, gap: 6 },
  balance: {
    fontSize: 40,
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  balanceAfn: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textMuted },
  actions: {
    // INVARIANT: "I received" stays physical LEFT, "I gave" stays physical
    // RIGHT. Right-hand-is-giving cultural rule. Yoga WOULD auto-reverse
    // `flexDirection: 'row'` children if the Activity were RTL — that's
    // exactly the bug v0.2.4 shipped, with "I gave" landing on the left
    // for Persian users. We avoid it by ensuring the Activity is LTR via
    // _layout.tsx's I18nManager neutralization + one-shot migration
    // prompt. Internal direction (lib/direction.ts) does NOT touch this
    // row.
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 20,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  actionText: { fontSize: 14, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  list: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  pingBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgDefault,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: 12,
    backgroundColor: colors.bgInverted,
    paddingHorizontal: 16,
  },
  pingButtonLabel: {
    color: colors.textInverted,
    fontFamily: fonts.sansSemi,
    fontSize: 15,
  },
});
