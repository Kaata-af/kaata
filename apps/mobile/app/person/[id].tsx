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
import { getLocalSelf, getPerson, listEntries, softDeleteEntry } from "../../lib/db";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { shareKaataViaWhatsApp } from "../../lib/share";
import type { Entry, PersonWithBalance, Self } from "../../lib/types";

export default function PersonDetailScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

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
    person.balance > 0 ? "THEY OWE YOU" : person.balance < 0 ? "YOU OWE THEM" : null;
  const chipVariant: "collect" | "pay" | null =
    person.balance > 0 ? "collect" : person.balance < 0 ? "pay" : null;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerNav}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textEmphasis} />
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
          <Text style={styles.name}>{person.name}</Text>
          {person.phone ? <Text style={styles.phone}>{person.phone}</Text> : null}
          <View style={{ height: 16 }} />
          {chipLabel && chipVariant ? (
            <Chip label={chipLabel} variant={chipVariant} />
          ) : entries.length > 0 ? (
            <Chip label="SETTLED" variant="neutral" />
          ) : null}
          <View style={styles.balanceRow}>
            <Text style={[styles.balance, !hasBalance && { color: colors.textMuted }]}>
              {formatAmount(abs)}
            </Text>
            <Text style={styles.balanceAfn}>AFN</Text>
          </View>
        </View>

        {/*
         * INVARIANT: "I gave" is on the RIGHT, "I received" on the LEFT.
         * Cultural — the right hand is the giving hand. This ordering must
         * be preserved across locales and must NOT auto-flip if/when full
         * RTL is added later. If you introduce I18nManager-driven
         * row-reverse anywhere, this row needs to opt out.
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
            <Text style={styles.actionText}>I received</Text>
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
            <Text style={styles.actionText}>I gave</Text>
          </Pressable>
        </View>

        {entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            subtitle={`Tap "I gave" when money or goods leave your hand, "I received" when they come in.`}
          />
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
              Ping {person.name} on WhatsApp
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
            label: "Edit",
            icon: "create-outline",
            onPress: () => {
              const eid = sheetFor?.id;
              if (eid) router.push({ pathname: "/entry/[id]/edit", params: { id: eid } });
            },
          },
          {
            label: "Delete",
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title="Delete this entry?"
        description="The amount stops counting toward this person's balance. You can't undo this from here."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            await softDeleteEntry(confirmDeleteFor.id);
            await load();
            toast.push("Entry deleted", "success");
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
